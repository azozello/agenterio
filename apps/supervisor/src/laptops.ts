import { createHash, randomBytes } from "node:crypto";
import Docker from "dockerode";

export interface LaptopSpec {
  handle: string;
  projectKey: string;
  env: Record<string, string>;
}

export interface Laptop {
  containerId: string;
  /** WebSocket URL of the worker, bound to 127.0.0.1 on the host. */
  url: string;
  secret: string;
}

/** Where agents' laptops come from. Docker now; a VM provider can implement the same interface later. */
export interface LaptopProvider {
  ensure(spec: LaptopSpec): Promise<Laptop>;
  destroy(handle: string): Promise<void>;
}

const WORKER_PORT = "7070/tcp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const containerName = (handle: string) => `agentslack-laptop-${handle}`;

/**
 * One container per agent, named after its handle, with a persistent home volume for its
 * checkouts and caches. A container is recreated when the image or its environment changes.
 */
export class DockerLaptops implements LaptopProvider {
  private readonly docker = new Docker();

  constructor(private readonly image: string) {}

  async ensure(spec: LaptopSpec): Promise<Laptop> {
    const image = await this.docker
      .getImage(this.image)
      .inspect()
      .catch(() => {
        throw new Error(`laptop image ${this.image} not found; build it with: pnpm laptop:build`);
      });
    const configHash = createHash("sha256")
      .update(JSON.stringify({ image: image.Id, project: spec.projectKey, env: spec.env }))
      .digest("hex")
      .slice(0, 16);

    const container = this.docker.getContainer(containerName(spec.handle));
    let info = await container.inspect().catch((err: { statusCode?: number }) => {
      if (err.statusCode === 404) return null;
      throw err;
    });
    if (info && info.Config.Labels["agentslack.config"] !== configHash) {
      await container.remove({ force: true });
      info = null;
    }

    if (!info) {
      const secret = randomBytes(24).toString("base64url");
      const created = await this.docker.createContainer({
        name: containerName(spec.handle),
        Image: this.image,
        Env: Object.entries({ ...spec.env, WORKER_SECRET: secret }).map(([k, v]) => `${k}=${v}`),
        Labels: {
          "agentslack.agent": spec.handle,
          "agentslack.project": spec.projectKey,
          "agentslack.config": configHash,
          "agentslack.secret": secret,
        },
        ExposedPorts: { [WORKER_PORT]: {} },
        HostConfig: {
          PortBindings: { [WORKER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
          Binds: [`agentslack-home-${spec.handle}:/home/agent`],
          ExtraHosts: ["host.docker.internal:host-gateway"],
        },
      });
      await created.start();
      info = await created.inspect();
    } else if (!info.State.Running) {
      await container.start();
      info = await container.inspect();
    }

    const port = info.NetworkSettings.Ports[WORKER_PORT]?.[0]?.HostPort;
    if (!port) throw new Error(`laptop ${spec.handle} has no worker port`);
    await this.waitHealthy(`http://127.0.0.1:${port}/health`, spec.handle);
    return { containerId: info.Id, url: `ws://127.0.0.1:${port}`, secret: info.Config.Labels["agentslack.secret"]! };
  }

  async destroy(handle: string): Promise<void> {
    await this.docker
      .getContainer(containerName(handle))
      .remove({ force: true })
      .catch((err: { statusCode?: number }) => {
        if (err.statusCode !== 404) throw err;
      });
  }

  private async waitHealthy(url: string, handle: string) {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url)).ok) return;
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    throw new Error(`laptop ${handle} did not become healthy`);
  }
}
