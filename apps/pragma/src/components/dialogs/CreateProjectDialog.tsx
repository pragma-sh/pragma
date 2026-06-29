import { useState } from "react";
import { errorMessage } from "@/lib/errors";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalShell } from "@/components/ui/modal-shell";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import {
  addProject,
  cloneProject,
  connectRemoteProject,
  getProjectsDirectory,
  pickDirectory,
  type RemoteAuthChoice,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type AuthKind = "agent" | "key" | "password";

export function CreateProjectDialog({ open: isOpen, onOpenChange }: CreateProjectDialogProps) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const workspace = useWorkspace();
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) {
    return null;
  }

  async function adopt(load: () => Promise<{ id: string } | null>) {
    try {
      setError(null);
      const project = await load();
      if (project === null) {
        return;
      }
      await workspace.reload();
      await workspace.selectProject(project.id);
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function openExisting() {
    await adopt(async () => {
      const selected = await pickDirectory(await getProjectsDirectory());
      return selected === null ? null : addProject(selected);
    });
  }

  async function cloneRemote() {
    await adopt(async () => {
      const selected = await pickDirectory(await getProjectsDirectory());
      return selected === null ? null : cloneProject(remoteUrl, selected);
    });
  }

  return (
    <ModalShell>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Add project</h2>
        <p className="text-sm text-muted-foreground">
          Open a local checkout, clone a repo, or connect to one over SSH.
        </p>
      </div>
      <Tabs defaultValue="local" className="mt-5">
        <TabsList className="w-full">
          <TabsTrigger value="local" className="flex-1">
            Local
          </TabsTrigger>
          <TabsTrigger value="remote" className="flex-1">
            Remote
          </TabsTrigger>
        </TabsList>

        <TabsContent value="local" className="mt-4 space-y-4">
          <Button className="w-full" onClick={() => void openExisting()}>
            Open existing git checkout
          </Button>
          <div className="space-y-2">
            <Label htmlFor="remote-url">Remote URL</Label>
            <Input
              id="remote-url"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              placeholder="git@github.com:owner/repo.git"
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
            <Button
              className="w-full"
              disabled={!remoteUrl.trim()}
              variant="outline"
              onClick={() => void cloneRemote()}
            >
              Clone remote
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="remote" className="mt-4">
          <RemoteProjectForm onConnect={adopt} onError={setError} />
        </TabsContent>
      </Tabs>

      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      <div className="mt-5 flex justify-end">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      </div>
    </ModalShell>
  );
}

interface RemoteProjectFormProps {
  onConnect: (load: () => Promise<{ id: string } | null>) => Promise<void>;
  onError: (message: string | null) => void;
}

/** SSH connection form for the Remote tab. Agent auth is the default; key file
 * and password live under a collapsible "More options". */
function RemoteProjectForm({ onConnect, onError }: RemoteProjectFormProps) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [path, setPath] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("agent");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);

  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535;
  const credentialsReady =
    authKind === "agent" ||
    (authKind === "key" && keyPath.trim() !== "") ||
    (authKind === "password" && password !== "");
  const canConnect =
    host.trim() !== "" && user.trim() !== "" && path.trim() !== "" && portValid && credentialsReady;

  function buildAuth(): RemoteAuthChoice {
    if (authKind === "key") {
      return {
        kind: "key",
        path: keyPath.trim(),
        passphrase: passphrase === "" ? null : passphrase,
      };
    }
    if (authKind === "password") {
      return { kind: "password", password };
    }
    return { kind: "agent" };
  }

  async function connect() {
    setConnecting(true);
    onError(null);
    try {
      await onConnect(() =>
        connectRemoteProject({
          host: host.trim(),
          port: portNumber,
          user: user.trim(),
          auth: buildAuth(),
          path: path.trim(),
        }),
      );
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div className="space-y-2">
          <Label htmlFor="ssh-host">Host</Label>
          <Input
            id="ssh-host"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
            placeholder="example.com"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
        </div>
        <div className="w-20 space-y-2">
          <Label htmlFor="ssh-port">Port</Label>
          <Input
            id="ssh-port"
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ssh-user">User</Label>
        <Input
          id="ssh-user"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck="false"
          placeholder="ubuntu"
          value={user}
          onChange={(event) => setUser(event.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="ssh-path">Project path</Label>
        <Input
          id="ssh-path"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck="false"
          placeholder="~/projects/remote-project"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Must be an existing git repository on the host.
        </p>
      </div>

      <Collapsible>
        <CollapsibleTrigger className="text-sm text-muted-foreground hover:text-foreground">
          Authentication: {authLabel(authKind)} · More options
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <RadioGroup
            value={authKind}
            onValueChange={(value) => setAuthKind(value as AuthKind)}
            className="space-y-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="agent" id="auth-agent" />
              <Label htmlFor="auth-agent" className="font-normal">
                SSH agent (recommended)
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="key" id="auth-key" />
              <Label htmlFor="auth-key" className="font-normal">
                Private key file
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="password" id="auth-password" />
              <Label htmlFor="auth-password" className="font-normal">
                Password
              </Label>
            </div>
          </RadioGroup>

          {authKind === "key" ? (
            <div className="space-y-2">
              <Input
                aria-label="Private key path"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck="false"
                placeholder="~/.ssh/id_ed25519"
                value={keyPath}
                onChange={(event) => setKeyPath(event.target.value)}
              />
              <Input
                aria-label="Key passphrase"
                type="password"
                placeholder="Passphrase (if encrypted)"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
          ) : null}

          {authKind === "password" ? (
            <Input
              aria-label="SSH password"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : null}
        </CollapsibleContent>
      </Collapsible>

      <Button
        className="w-full"
        disabled={!canConnect || connecting}
        onClick={() => void connect()}
      >
        {connecting ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}

function authLabel(kind: AuthKind): string {
  if (kind === "key") {
    return "private key";
  }
  if (kind === "password") {
    return "password";
  }
  return "SSH agent";
}
