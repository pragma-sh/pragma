import type { Metadata } from "next";

import { privacyLastUpdated, privacyRoute } from "@/lib/legal";
import { appName, gitConfig } from "@/lib/shared";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${appName} and Pragma Go handle your data.`,
  // The URL submitted to App Store Connect, so the canonical one has to match
  // it exactly rather than whatever path a crawler happened to arrive on.
  alternates: { canonical: privacyRoute },
};

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

export default function PrivacyPage() {
  return (
    <main className="prose mx-auto w-full max-w-3xl px-6 py-16">
      <h1>Privacy Policy</h1>
      <p className="text-fd-muted-foreground">Last updated: {privacyLastUpdated}</p>

      <p>
        This policy covers <strong>Pragma</strong>, the desktop application, and{" "}
        <strong>Pragma Go</strong>, its companion app for iPhone, Android, and the browser. Both are
        open source; the code described here can be read at <a href={repoUrl}>{repoUrl}</a>.
      </p>

      <h2>The short version</h2>
      <p>
        Pragma runs on your computer, and Pragma Go talks to the copy of Pragma <em>you</em> pair it
        with. Your projects, your code, and your agent conversations stay on machines you control.
      </p>
      <p>
        <strong>As of the date above, we operate no service that receives your data</strong> &mdash;
        there is no analytics SDK, no crash reporter, no advertising identifier, and no tracking in
        either app. The sections below describe both what happens today and what would apply if that
        changes, so you can see the rules we hold ourselves to either way. We do not sell or rent
        personal information, we do not share it with data brokers, and we do not build advertising
        profiles &mdash; and those three commitments are not conditional on anything below.
      </p>

      <h2>What Pragma (desktop) stores</h2>
      <p>
        Everything Pragma keeps stays on your computer, in your home directory and in your projects:
      </p>
      <ul>
        <li>
          Your projects, git worktrees, terminal sessions, and agent transcripts, held on your local
          disk.
        </li>
        <li>
          Settings and keyboard shortcuts in <code>~/.pragma/</code> and in each project&rsquo;s{" "}
          <code>.pragma/</code> directory.
        </li>
        <li>
          A GitHub access token, if you choose to connect GitHub, written to a file readable only by
          your user account.
        </li>
      </ul>
      <p>None of this is transmitted to us.</p>

      <h2>What Pragma Go stores on your device</h2>
      <ul>
        <li>
          <strong>Connection details.</strong> The address and access token of the Pragma desktop
          you paired with, held in the operating system keychain (iOS Keychain, Android Keystore)
          or, in the browser build, in the browser&rsquo;s own storage.
        </li>
        <li>
          <strong>An installation identifier.</strong> A random value generated on your device so
          your paired desktop can list which devices are connected and let you revoke one. It is not
          derived from your identity or from any device or advertising identifier.
        </li>
        <li>
          <strong>Local interface state</strong>, such as which items you have dismissed.
        </li>
      </ul>
      <p>Unpairing removes the connection details and revokes the device on the desktop.</p>

      <h2>What Pragma Go sends, and where</h2>
      <p>
        Pragma Go sends your workspace requests to <strong>a destination you choose</strong>: the
        Pragma desktop you paired with, reached over a network address you supply during pairing.
        Those requests carry your access token, the installation identifier, the device platform and
        name, and the app version. Your workspace data, agent messages, and anything you type into
        an agent travel between your phone and your own computer.
      </p>
      <p>
        If you reach your desktop through a tunnelling service (for example ngrok or Cloudflare
        Tunnel), that service is chosen and configured by you, and its own privacy policy applies to
        traffic passing through it. Pragma does not select one for you.
      </p>

      <h2>Analytics and diagnostics</h2>
      <p>
        Neither app currently collects analytics, usage statistics, or crash reports. If we
        introduce them, they will be limited to product and stability data &mdash; which features
        are used, performance measurements, error and crash diagnostics, and coarse environment
        details such as app version, operating system version, and device model.
      </p>
      <p>
        Whatever form they take, these rules apply: diagnostics will never include the contents of
        your code, your prompts, your agent conversations, your file paths, your repository names,
        or your credentials. They will not be used for advertising or sold to anyone. Collection
        will be disclosed on this page before it begins, with the date above updated, and the change
        will be visible in the repository&rsquo;s public history.
      </p>

      <h2>Services we may operate</h2>
      <p>
        Today Pragma has no accounts and no backend of ours; the only server involved is the one
        running on your own computer. We may later offer optional hosted services &mdash; for
        example an account, a relay that reaches your desktop without you configuring a tunnel, sync
        between your devices, or a licensing and payment system.
      </p>
      <p>
        If we do, this page will describe each service before it launches: what it receives, how
        long it is kept, and who processes it on our behalf. Such services will be
        <strong> optional and additive</strong> &mdash; running Pragma against your own machine,
        with no account, will remain supported. A relay, if we build one, is intended to pass
        encrypted traffic through without reading its contents.
      </p>

      <h2>Push notifications</h2>
      <p>
        If you allow notifications, Pragma Go registers a push token with{" "}
        <a href="https://expo.dev/privacy">Expo&rsquo;s push notification service</a>, which relays
        through Apple Push Notification service or Firebase Cloud Messaging. Your paired desktop
        sends alerts &mdash; such as an agent waiting on your approval &mdash; through that relay,
        so the alert text and the push token pass through Expo and Apple or Google on the way to
        your device. Denying the notification permission, or never pairing, means no push token is
        ever created.
      </p>

      <h2>Camera</h2>
      <p>
        Pragma Go asks for camera access for one purpose: scanning the pairing QR code your desktop
        displays. Frames are examined on the device to find the code and are never stored, uploaded,
        or used for anything else. You can skip the camera entirely and type the pairing details by
        hand.
      </p>

      <h2>Third parties</h2>
      <p>
        Depending on what you set up, these third parties may receive data{" "}
        <em>at your direction</em>:
      </p>
      <ul>
        <li>
          <strong>AI model providers.</strong> Coding agents you run on the desktop send your
          prompts and the code they read to the model provider you configured. That provider&rsquo;s
          terms and privacy policy govern that data.
        </li>
        <li>
          <strong>GitHub</strong>, if you connect it, for the repositories and pull requests you act
          on.
        </li>
        <li>
          <strong>Expo, Apple, and Google</strong>, for delivering push notifications, as described
          above.
        </li>
        <li>
          <strong>Your tunnelling provider</strong>, if you use one to reach your desktop remotely.
        </li>
      </ul>
      <p>
        Any processor we engage for a service of our own will be named on this page, and will be
        bound to use the data only to provide that service to us.
      </p>

      <h2>Children</h2>
      <p>
        Pragma is a developer tool and is not directed at children. We do not knowingly collect
        information from anyone under 13.
      </p>

      <h2>Your choices and your rights</h2>
      <p>
        Because your data lives on your own machines, you control it directly: unpair a device to
        revoke its access, delete <code>~/.pragma/</code> to remove desktop settings, disconnect
        GitHub to invalidate the stored token, and uninstall either app to remove its local storage.
        There is no account to delete, because there is no account.
      </p>
      <p>
        Should we later hold data about you, you may ask us what we hold, ask for a copy, ask us to
        correct or delete it, and object to a particular use &mdash; and analytics, if introduced,
        will be something you can turn off.
      </p>

      <h2>Changes</h2>
      <p>
        When this policy changes, the date at the top changes with it. Changes that expand what is
        collected take effect only going forward, and are published here before the collection
        begins. Every revision is visible in the public git history of this site.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy, or a request about your data: open an issue at{" "}
        <a href={`${repoUrl}/issues`}>{repoUrl}/issues</a>. Note that issues are public &mdash; do
        not include anything confidential.
      </p>
    </main>
  );
}
