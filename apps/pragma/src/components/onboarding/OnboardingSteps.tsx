import { useState } from "react";

import { Icon } from "@iconify/react";
import { Blocks, BookOpen, Check, FolderPlus, Palette, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { constants } from "@pragma/constants";
import type { LockedPlugin } from "@pragma/plugin-registry";

import { AiAuthOptions } from "@/components/ai/AiAuthOptions";
import { GitHubAuthOptions } from "@/components/github/GitHubAuthOptions";
import { OnboardingFrame } from "@/components/onboarding/OnboardingFrame";
import { PreviewVideo } from "@/components/onboarding/PreviewVideo";
import { ThemePresetGrid } from "@/components/settings/ThemePresetGrid";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/errors";
import { installLockedPlugin } from "@/lib/plugin-registry";
import { installPragmaSkill, writeTheme } from "@/lib/tauri";
import { serializeThemeFile, THEME_CHANGED_EVENT } from "@/lib/theme";
import { withThemePreset, type ThemePreset } from "@/lib/theme-presets";
import { useRecommendedAgentPlugins } from "@/hooks/use-recommended-agent-plugins";
import { useAi } from "@/state/ai-context";
import { useGitHub } from "@/state/github-context";
import { useTheme } from "@/state/theme-context";

/** Every step gets the same navigation callbacks from the modal. */
export interface StepProps {
  onBack?: () => void;
  onNext: () => void;
}

/** Opening screen: what Pragma is, and what the next few minutes cover. */
export function WelcomeStep({ onNext }: StepProps) {
  return (
    <OnboardingFrame
      description="Pragma runs your coding agents in isolated git worktrees, each with its own terminals, browser, and pull request. This quick setup connects the pieces it needs."
      icon={<Icon className="size-6" icon="lucide:sparkles" />}
      nextLabel="Get started"
      onNext={onNext}
      title="Welcome to Pragma"
    >
      <ul className="mx-auto grid max-w-sm gap-2 text-sm text-muted-foreground">
        <li className="flex items-center gap-2">
          <Check className="size-4 shrink-0 text-primary" /> Sign in to GitHub for pull requests
        </li>
        <li className="flex items-center gap-2">
          <Check className="size-4 shrink-0 text-primary" /> Connect an AI provider
        </li>
        <li className="flex items-center gap-2">
          <Check className="size-4 shrink-0 text-primary" /> Hook up your agent CLIs and skills
        </li>
        <li className="flex items-center gap-2">
          <Check className="size-4 shrink-0 text-primary" /> Pick a theme and add your first project
        </li>
      </ul>
    </OnboardingFrame>
  );
}

/** GitHub sign-in, with the trust note that explains what the token can reach. */
export function GitHubStep({ onBack, onNext }: StepProps) {
  const { authenticated, dismissSetup, status } = useGitHub();

  function skip() {
    void dismissSetup();
    onNext();
  }

  return (
    <OnboardingFrame
      description="Pragma opens, reviews, and merges pull requests from inside a worktree — that needs your GitHub account. Sign in with the device flow, or reuse a token the gh CLI already holds."
      footnote={
        <p className="flex gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            The token is stored in an owner-only file on this machine and is never sent anywhere but
            GitHub. Pragma asks only for the scopes it uses, and you can revoke it any time from
            Settings → GitHub or your GitHub account settings.
          </span>
        </p>
      }
      icon={<Icon className="size-6" icon="simple-icons:github" />}
      media={
        <PreviewVideo
          file="github.mp4"
          label="Reviewing and merging a pull request inside Pragma"
        />
      }
      nextDisabled={!authenticated}
      onBack={onBack}
      onNext={onNext}
      onSkip={skip}
      title="Sign in with GitHub"
    >
      <div>
        {authenticated ? (
          <p className="flex items-center justify-center gap-2 rounded-md border bg-card px-4 py-3 text-sm">
            <Check className="size-4 shrink-0 text-primary" />
            Signed in{status?.user?.login ? ` as ${status.user.login}` : ""}.
          </p>
        ) : (
          <GitHubAuthOptions className="w-full" />
        )}
      </div>
    </OnboardingFrame>
  );
}

/** AI provider connection — powers commit messages, reviews, and the AI helpers. */
export function AiStep({ onBack, onNext }: StepProps) {
  const { dismissSetup, status } = useAi();
  const connected = (status?.signedIn.length ?? 0) > 0;

  function skip() {
    void dismissSetup();
    onNext();
  }

  return (
    <OnboardingFrame
      description="Connect a provider — a subscription sign-in or an API key — to power commit messages, PR descriptions, review summaries, and the built-in helpers. Your agents keep their own credentials; this is Pragma's."
      icon={<Sparkles className="size-6" />}
      media={<PreviewVideo file="ai.mp4" label="Pragma's AI helpers writing a commit message" />}
      nextDisabled={!connected}
      onBack={onBack}
      onNext={onNext}
      onSkip={skip}
      title="Connect an AI provider"
    >
      <AiAuthOptions />
    </OnboardingFrame>
  );
}

/** Recommends official integrations for the agent CLIs found on this machine. */
export function AgentPluginsStep({ onBack, onNext }: StepProps) {
  const { loaded, recommended } = useRecommendedAgentPlugins();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const packages = selected ?? new Set(recommended.map((plugin) => plugin.package));

  function install() {
    const chosen = recommended.filter((plugin) => packages.has(plugin.package));
    onNext();
    void installAll(chosen);
  }

  return (
    <OnboardingFrame
      description={
        recommended.length > 0
          ? "Pragma found these agent CLIs on this machine. Installing their integrations reports status, questions, and usage back into Pragma."
          : "Agent integrations report status, questions, and usage back into Pragma. None of the supported CLIs were found on this machine — install one later from Settings → Plugins."
      }
      icon={<Blocks className="size-6" />}
      nextDisabled={recommended.length > 0 && packages.size === 0}
      nextLabel={recommended.length > 0 ? "Install selected" : "Continue"}
      onBack={onBack}
      onNext={recommended.length > 0 ? install : onNext}
      onSkip={recommended.length > 0 ? onNext : undefined}
      title="Connect your agents"
    >
      {loaded && recommended.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {recommended.map((plugin) => (
            <li key={plugin.package}>
              <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-medium">{plugin.manifest.name}</span>
                <Checkbox
                  checked={packages.has(plugin.package)}
                  onCheckedChange={(checked) => {
                    const next = new Set(packages);
                    if (checked === true) next.add(plugin.package);
                    else next.delete(plugin.package);
                    setSelected(next);
                  }}
                />
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </OnboardingFrame>
  );
}

/** Installs the recommended plugins in sequence, reporting the outcome once. */
async function installAll(plugins: LockedPlugin[]): Promise<void> {
  if (plugins.length === 0) return;
  try {
    for (const plugin of plugins) {
      await installLockedPlugin(plugin).catch((cause: unknown) => {
        throw new Error(`${plugin.manifest.name}: ${errorMessage(cause)}`);
      });
    }
    toast.success("Recommended agent plugins installed");
  } catch (cause) {
    toast.error("Recommended agent plugin installation failed", {
      description: errorMessage(cause),
    });
  }
}

/** Offers the bundled Pragma skill, per global skill directory. */
export function SkillsStep({ onBack, onNext }: StepProps) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const targets = constants.onboarding.skill.targets;

  async function install(targetIds: string[], busyId: string) {
    setInstalling(busyId);
    try {
      const paths = await installPragmaSkill(targetIds);
      setInstalled((current) => {
        const next = new Set(current);
        for (const id of targetIds) next.add(id);
        return next;
      });
      toast.success("Pragma skill installed", { description: paths.join(", ") });
    } catch (cause) {
      toast.error("Could not install the Pragma skill", { description: errorMessage(cause) });
    } finally {
      setInstalling(null);
    }
  }

  const allInstalled = targets.every((target) => installed.has(target.id));

  return (
    <OnboardingFrame
      description={`Pragma ships a skill that teaches an agent how to drive Pragma itself — worktrees, tabs, scratchpads, fanouts, the CLI and the SDK. Install it in ${targets.map((target) => `~/${target.directory.split("/")[0]}`).join(" or ")} — or both. Either way it is written globally, so every project gets it.`}
      footnote={
        <p>
          Installed as a plain directory you can inspect or delete:{" "}
          {targets.map((target, index) => (
            <span key={target.id}>
              {index > 0 ? ", " : ""}
              <code className="font-mono">
                ~/{target.directory}/{constants.onboarding.skill.id}
              </code>
            </span>
          ))}
          .
        </p>
      }
      icon={<BookOpen className="size-6" />}
      nextDisabled={installed.size === 0}
      nextLabel="Continue"
      onBack={onBack}
      onNext={onNext}
      onSkip={onNext}
      title="Install the Pragma skill"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          {targets.map((target) => (
            <Button
              className="min-w-0 flex-1 whitespace-normal"
              disabled={installing !== null}
              key={target.id}
              onClick={() => void install([target.id], target.id)}
              variant={installed.has(target.id) ? "outline" : "default"}
            >
              {installed.has(target.id) ? <Check className="size-4" /> : null}
              {installed.has(target.id)
                ? `Installed in ~/${target.directory.split("/")[0]}`
                : `Install in ~/${target.directory.split("/")[0]}`}
            </Button>
          ))}
        </div>
        <Button
          disabled={installing !== null || allInstalled}
          onClick={() =>
            void install(
              targets.map((target) => target.id),
              "all",
            )
          }
          variant="outline"
        >
          {allInstalled ? <Check className="size-4" /> : null}
          {allInstalled ? "Installed in both" : "Install in both"}
        </Button>
      </div>
    </OnboardingFrame>
  );
}

/** Theme picker mirroring Settings → Theme's built-in palettes. */
export function ThemeStep({ onBack, onNext }: StepProps) {
  const theme = useTheme();
  const [saving, setSaving] = useState(false);
  // A theme file that already carries colors counts as a choice, so replaying
  // the flow does not force the palette to be picked again.
  const [chosen, setChosen] = useState(() => Boolean(theme.global?.colors));

  async function apply(preset: ThemePreset) {
    setSaving(true);
    try {
      await writeTheme("global", serializeThemeFile(withThemePreset(theme.global, preset)), null);
      window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
      setChosen(true);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <OnboardingFrame
      description="Pick a palette. It applies immediately and writes your global theme — the same list lives in Settings → Theme, where you can also override individual colors or set a per-project theme."
      icon={<Palette className="size-6" />}
      nextDisabled={!chosen}
      onBack={onBack}
      onNext={onNext}
      onSkip={onNext}
      title="Choose a theme"
    >
      <ThemePresetGrid
        current={theme.global}
        defaultIsActive={!theme.global?.colors}
        disabled={saving}
        mode="dark"
        onSelect={(preset) => void apply(preset)}
      />
    </OnboardingFrame>
  );
}

/** Closing screen: add a project, which is what everything else hangs off. */
export function ProjectStep({ onBack, onNext }: StepProps) {
  return (
    <OnboardingFrame
      description="A project is a git checkout. Pragma creates a worktree per task inside it, so agents work in parallel without stepping on each other. Open a local checkout, clone a repo, or connect one over SSH."
      icon={<FolderPlus className="size-6" />}
      nextLabel="Add a project"
      onBack={onBack}
      onNext={() => {
        onNext();
        window.dispatchEvent(new Event("pragma:create-project"));
      }}
      onSkip={onNext}
      skipLabel="Later"
      title="Add your first project"
    >
      <p className="text-muted-foreground text-center text-sm">
        Once a project is open, a short tour points out where worktrees, terminals, and agents live.
      </p>
    </OnboardingFrame>
  );
}
