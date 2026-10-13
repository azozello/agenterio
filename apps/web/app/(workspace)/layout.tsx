import { ProfilePanel } from "@/components/profile-panel";
import { Sidebar } from "@/components/sidebar";
import { ThreadPanel } from "@/components/thread-panel";
import { TopBar } from "@/components/top-bar";
import { WorkspaceProvider } from "@/lib/workspace";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceProvider>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
            {/* Only one of these renders: the workspace keeps a single right-panel state. */}
            <ProfilePanel />
            <ThreadPanel />
          </div>
        </main>
      </div>
    </WorkspaceProvider>
  );
}
