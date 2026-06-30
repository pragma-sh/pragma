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

interface RemoteConnectionFields {
  host: string;
  port: string;
  user: string;
  path: string;
}

const INITIAL_CONNECTION: RemoteConnectionFields = { host: "", port: "22", user: "", path: "" };

type RemoteAuthState =
  | { kind: "agent" }
  | { kind: "key"; path: string; passphrase: string }
  | { kind: "password"; password: string };

const INITIAL_AUTH: RemoteAuthState = { kind: "agent" };

function isPortValid(port: string): boolean {
  const portNumber = Number(port);
  return Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535;
}

function isAuthReady(auth: RemoteAuthState): boolean {
  if (auth.kind === "key") {
    return auth.path.trim() !== "";
  }
  if (auth.kind === "password") {
    return auth.password !== "";
  }
  return true;
}

function toAuthChoice(auth: RemoteAuthState): RemoteAuthChoice {
  if (auth.kind === "key") {
    return { kind: "key", path: auth.path.trim(), passphrase: auth.passphrase || null };
  }
  if (auth.kind === "password") {
    return { kind: "password", password: auth.password };
  }
  return { kind: "agent" };
}

interface RemoteProjectFormProps {
  onConnect: (load: () => Promise<{ id: string } | null>) => Promise<void>;
  onError: (message: string | null) => void;
}

/** SSH connection form for the Remote tab. Agent auth is the default; key file
 * and password live under a collapsible "More options". */
function RemoteProjectForm({ onConnect, onError }: RemoteProjectFormProps) {
  const [connection, setConnection] = useState<RemoteConnectionFields>(INITIAL_CONNECTION);
  const [auth, setAuth] = useState<RemoteAuthState>(INITIAL_AUTH);
  const [connecting, setConnecting] = useState(false);

  const { host, port, user, path } = connection;
  const canConnect =
    host.trim() !== "" &&
    user.trim() !== "" &&
    path.trim() !== "" &&
    isPortValid(port) &&
    isAuthReady(auth);

  async function connect() {
    setConnecting(true);
    onError(null);
    try {
      await onConnect(() =>
        connectRemoteProject({
          host: host.trim(),
          port: Number(port),
          user: user.trim(),
          auth: toAuthChoice(auth),
          path: path.trim(),
        }),
      );
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <RemoteConnectionFieldset value={connection} onChange={setConnection} />
      <RemoteAuthFields value={auth} onChange={setAuth} />
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

interface RemoteConnectionFieldsetProps {
  value: RemoteConnectionFields;
  onChange: (next: RemoteConnectionFields) => void;
}

function RemoteConnectionFieldset({ value, onChange }: RemoteConnectionFieldsetProps) {
  return (
    <>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div className="space-y-2">
          <Label htmlFor="ssh-host">Host</Label>
          <Input
            id="ssh-host"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
            placeholder="example.com"
            value={value.host}
            onChange={(event) => onChange({ ...value, host: event.target.value })}
          />
        </div>
        <div className="w-20 space-y-2">
          <Label htmlFor="ssh-port">Port</Label>
          <Input
            id="ssh-port"
            inputMode="numeric"
            value={value.port}
            onChange={(event) => onChange({ ...value, port: event.target.value })}
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
          value={value.user}
          onChange={(event) => onChange({ ...value, user: event.target.value })}
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
          value={value.path}
          onChange={(event) => onChange({ ...value, path: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Must be an existing git repository on the host.
        </p>
      </div>
    </>
  );
}

interface RemoteAuthFieldsProps {
  value: RemoteAuthState;
  onChange: (next: RemoteAuthState) => void;
}

function RemoteAuthFields({ value, onChange }: RemoteAuthFieldsProps) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-sm text-muted-foreground hover:text-foreground">
        Authentication: {authLabel(value.kind)} · More options
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3">
        <RadioGroup
          value={value.kind}
          onValueChange={(kind) => onChange(authStateForKind(kind, value))}
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

        {value.kind === "key" ? (
          <div className="space-y-2">
            <Input
              aria-label="Private key path"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck="false"
              placeholder="~/.ssh/id_ed25519"
              value={value.path}
              onChange={(event) => onChange({ ...value, path: event.target.value })}
            />
            <Input
              aria-label="Key passphrase"
              type="password"
              placeholder="Passphrase (if encrypted)"
              value={value.passphrase}
              onChange={(event) => onChange({ ...value, passphrase: event.target.value })}
            />
          </div>
        ) : null}

        {value.kind === "password" ? (
          <Input
            aria-label="SSH password"
            type="password"
            placeholder="Password"
            value={value.password}
            onChange={(event) => onChange({ ...value, password: event.target.value })}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function authStateForKind(kind: string, previous: RemoteAuthState): RemoteAuthState {
  if (kind === "key") {
    return previous.kind === "key" ? previous : { kind: "key", path: "", passphrase: "" };
  }
  if (kind === "password") {
    return previous.kind === "password" ? previous : { kind: "password", password: "" };
  }
  return { kind: "agent" };
}

function authLabel(kind: RemoteAuthState["kind"]): string {
  if (kind === "key") {
    return "private key";
  }
  if (kind === "password") {
    return "password";
  }
  return "SSH agent";
}
