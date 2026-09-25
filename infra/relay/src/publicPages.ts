// Keep these disclosures aligned with Exarch Mobile's in-app privacy pages.
// Serve with the relay's static-page CSP. No scripts, forms or tracking.
const contact = "dillonc@sandflatllc.com";
const issues = "https://github.com/exarch-run/exarch/issues";
type Section = { heading: string; paragraphs: readonly string[] };
type Page = { title: string; intro: string; sections: readonly Section[] };

const pages: Record<string, Page> = {
  "/privacy": {
    title: "Exarch Mobile privacy policy",
    intro:
      "Updated September 24, 2026. This policy covers Exarch Mobile and its account, connection, notification and response-reporting services. Exarch is published by Dillon Cluck.",
    sections: [
      {
        heading: "Your phone and computer",
        paragraphs: [
          "Exarch Mobile connects to a computer you have linked. Messages, photos, files and project context travel to that computer. Chats and project files live on your computer, which runs the AI tools you choose.",
          "The phone saves drafts, messages waiting to send, a recent chat list, computer connections and sign-in keys. It does not keep a complete chat transcript. Keys use the operating system's secure storage. Android cloud backup is disabled for the app. Some iPhone Keychain entries can survive uninstalling the app.",
        ],
      },
      {
        heading: "Accounts and connections",
        paragraphs: [
          "Clerk processes your email address, authentication information and sign-in activity to authenticate your Exarch account. Sign-in uses an email code or a password if your account has one.",
          "The relay stores your account identifier, computer links, connection credentials and device registrations to connect your phone to your computers. Cloudflare supplies the relay and managed network tunnels. PlanetScale stores relay records in the United States. Ordinary account connections use HTTPS through this infrastructure. The infrastructure processes network metadata, including IP addresses, to deliver and protect connections.",
          "Direct development connections use the address you configure and can use unencrypted HTTP. Use them only on networks you trust.",
        ],
      },
      {
        heading: "Notifications and diagnostics",
        paragraphs: [
          "When signed in, the phone can register its device identifier, operating system, app version and notification preferences with the relay. Allowing notifications adds a push token. The relay stores project names, chat titles and brief activity status for notification delivery. Alerts can show a chat title on your lock screen. Apple or Google's push service delivers them. Delivery queues temporarily hold the notification and push address. Undelivered messages can remain queued for up to 24 hours on the current plan. Finished activity records are removed after 30 minutes; stale running activity after two hours, waiting activity and cached summaries after 24 hours, through regular cleanup.",
          "Routine account-linked request tracing and persistent relay Worker logs are disabled. Short-lived delivery records contain a random job identifier, time and outcome, without account, device, computer or chat identifiers or a push-token suffix. Records older than one hour are removed by regular cleanup. Earlier diagnostic traces expire under their existing 30-day schedule. Cloudflare still processes network metadata to operate and protect connections. This phone app does not include advertising or cross-app tracking.",
        ],
      },
      {
        heading: "AI providers and Private",
        paragraphs: [
          "Exarch does not host AI inference. Your computer sends your messages, attachments and relevant project context to the AI providers connected on that computer. Those services have their own terms and retention settings.",
          "Private uses the route configured on your computer, such as Tinfoil or a zero data retention gateway key. Provider handling depends on that route and its settings. A Private label is not a promise that the entire Exarch service retains no data. Check your computer's route before sending sensitive information.",
        ],
      },
      {
        heading: "Reporting an AI response",
        paragraphs: [
          "Report response lets you review and edit the text you send to Exarch's developer. A report includes the selected excerpt, your reason, optional notes, a content hash, receipt identifier and time received. Other messages, attachments and account credentials are not automatically included. The report table does not store an account identifier, device identifier or IP address. Network services still process request metadata.",
          "Reporting a Private response shares the text you approve outside your private AI connection. Report drafts close when the app enters the background. A receipt confirms that the service accepted your report.",
          "Reports are used to investigate harmful or misleading responses and improve safeguards. Reports are deleted from the active database when handled. Unresolved reports expire after seven days through regular cleanup. Email the receipt identifier to request earlier removal. Deleted records can remain in existing database backups, which have a two-day retention schedule.",
        ],
      },
      {
        heading: "Photos, files and dictation",
        paragraphs: [
          "You choose which photos or files to attach. Dictation uses your phone's speech recognition. Depending on the device and settings, Apple or Google may process the audio. Exarch sends the resulting text to your computer.",
        ],
      },
      {
        heading: "Retention and account deletion",
        paragraphs: [
          "Account and connection records remain while needed to operate your account. In the phone app, open Settings, Account, Delete account. The relay refuses new account access when it accepts the request, then removes the Clerk identity and related relay links, device and push registrations, activity records and connection records. Failed cleanup steps are retried. Existing computer sessions can last until cleanup or their expiry. A computer's shared credentials and activity remain while another account still links that computer.",
          "A temporary deletion record containing the account identifier remains for 24 hours after cleanup completes. Earlier diagnostic traces expire under their existing 30-day schedule. The relay database is backed up every 12 hours; the included schedule keeps each backup for two days. Backups expire separately from deletion in the active database. Deleting through Clerk's account portal is reconciled separately and may take about a day before relay cleanup begins.",
          "Account deletion does not erase files or chats on your own computer, revoke accounts you hold directly with AI providers, or identify reports submitted without an account identifier. Delete computer files there, manage provider accounts with the provider, and use a report receipt to request report removal. Signing out is not account deletion.",
          `You can request account deletion without the app by emailing ${contact} from the account's email address. We confirm requests using that address. Do not send a password, sign-in code, API key or identity document.`,
        ],
      },
      {
        heading: "Your choices and contact",
        paragraphs: [
          "You can turn off notifications and revoke microphone or photo access in your phone's settings. Use Exarch only with computers and content you are allowed to access. The service is not directed to children under 13.",
          `Contact Dillon Cluck at ${contact} for support, access, correction, deletion or other privacy requests. This policy may change as the service changes; the date above identifies the version.`,
        ],
      },
    ],
  },
  "/support": {
    title: "Exarch Mobile support",
    intro:
      "Exarch Mobile connects your phone to a computer running Exarch. Start on your computer, then sign in on your phone with the same account.",
    sections: [
      {
        heading: "Get help",
        paragraphs: [
          `Email ${contact}. Include your phone model, operating-system version, Exarch version and a description of what happened. Leave out passwords, sign-in codes, API keys and private chat content.`,
          `General bugs can also be reported at ${issues}. That page is public. Use email for private support and privacy requests.`,
        ],
      },
      {
        heading: "No computer appears",
        paragraphs: [
          "Open Exarch on your computer and connect your account in Settings, Phone. Keep that computer on and connected. Sign in on the phone with the same email address. Direct development connections have their own pairing flow.",
        ],
      },
      {
        heading: "Report an AI response",
        paragraphs: [
          "Choose Report response below the message. Review the selected text, choose a reason and submit it. Keep the receipt for follow-up. If the app says delivery failed, it has not confirmed receipt. Retry or contact support. Do not use response reports for emergencies.",
        ],
      },
      {
        heading: "Delete your account",
        paragraphs: [
          "Open Settings, Account, Delete account in the phone app. You can also use the email instructions on the account-deletion page linked below, without reinstalling the app.",
        ],
      },
    ],
  },
  "/terms": {
    title: "Exarch Mobile terms of use",
    intro:
      "Updated September 24, 2026. Exarch Mobile is provided by Dillon Cluck. These terms cover the mobile app and its connection services.",
    sections: [
      {
        heading: "Using Exarch",
        paragraphs: [
          "Use Exarch only with computers, accounts and content you have permission to access. You must be at least 13 and meet any higher minimum age required where you live. If you are below the age at which you can agree to these terms yourself, your parent or guardian must agree to your use.",
          "The mobile app is free to use. AI providers or other services you connect may charge under their own agreements. The phone app does not sell AI credits or subscriptions.",
        ],
      },
      {
        heading: "Your content and connected services",
        paragraphs: [
          "You keep whatever rights you have in content you provide. You authorize the processing and transmission needed to provide the features you use. Connected computers, AI providers and network services may have separate terms.",
          "AI responses can be wrong, incomplete or unsafe. Check important results before relying on them. You are responsible for deciding which actions agents may take on your computers and for keeping backups of important files.",
        ],
      },
      {
        heading: "Acceptable use",
        paragraphs: [
          "Do not use Exarch for illegal activity, child exploitation, fraud, unauthorized access, malware distribution, threats or infringement of others' rights. Do not try to bypass safeguards or interfere with the service. Access may be restricted to address abuse or protect the service.",
          "Use Report response to flag harmful AI output. Reports help the developer investigate and improve safeguards. They are not an emergency service.",
        ],
      },
      {
        heading: "Availability and leaving",
        paragraphs: [
          "Features depend on your computer, network and connected providers being available. The service can change or be interrupted. You can stop using it and request deletion of your account at any time. Nothing in these terms limits rights you have under applicable consumer law.",
          `For questions about these terms, email ${contact}. The privacy and deletion pages explain data handling and account removal.`,
        ],
      },
    ],
  },
  "/delete-account": {
    title: "Delete your Exarch account",
    intro:
      "You can request deletion in Exarch Mobile or by email. You do not need to reinstall the app to make a request.",
    sections: [
      {
        heading: "In the app",
        paragraphs: [
          "Open Settings, Account, Delete account. Read the confirmation and submit the request. When the relay accepts it, new relay access is blocked immediately and background cleanup starts. Existing computer sessions can last until cleanup or their expiry. If the request fails, the app tells you; retry or use email.",
        ],
      },
      {
        heading: "Without the app",
        paragraphs: [
          `Email ${contact} from the email address on your Exarch account with the subject Delete my Exarch account. The developer will confirm your request through that address and start the same account-deletion process. Never send your password, sign-in code or API keys.`,
        ],
      },
      {
        heading: "What is removed",
        paragraphs: [
          "Deletion removes your Exarch sign-in identity, relay computer links, phone and push registrations, Live Activity registrations and related delivery and connection records. A computer's shared credentials and activity are removed when no other account still links that computer. Cleanup runs in the background and retries failed steps.",
          "A temporary account-identifier record is kept for 24 hours after cleanup completes to continue refusing any remaining tokens for the deleted account. Earlier diagnostic traces expire under their existing 30-day schedule. Existing relay database backups expire under their two-day schedule, separately from deletion in the active database.",
        ],
      },
      {
        heading: "What you manage separately",
        paragraphs: [
          "Your computers retain their own chats and project files. Delete those files on the computer. Accounts and data held directly by your AI providers are managed with those providers.",
          `Response reports are not linked to an account identifier and are deleted when handled and expire after seven days through regular cleanup. For earlier deletion, email the report receipt to ${contact}. Uninstalling the app or signing out does not delete your Exarch account.`,
        ],
      },
    ],
  },
};

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

export function publicPage(pathname: string): string | undefined {
  const page = Object.hasOwn(pages, pathname) ? pages[pathname] : undefined;
  if (!page) return undefined;
  const content = page.sections
    .map(
      (section) =>
        `<section><h2>${escape(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}</section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(page.title)}</title><style>html{color-scheme:dark light}body{font:17px/1.6 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:32px 24px}h1{font-size:2rem;line-height:1.2}h2{font-size:1.25rem;margin-top:2rem}a{color:inherit;text-underline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:20px}footer{border-top:1px solid #888;padding-top:20px;margin-top:40px}p{overflow-wrap:anywhere}a:focus-visible{outline:3px solid currentColor;outline-offset:4px}</style></head><body><header><nav aria-label="Exarch information"><a href="/privacy">Privacy</a><a href="/support">Support</a><a href="/terms">Terms</a><a href="/delete-account">Delete account</a></nav></header><main><h1>${escape(page.title)}</h1><p>${escape(page.intro)}</p>${content}</main><footer><p>Exarch Mobile, published by Dillon Cluck.</p><p><a href="mailto:${contact}">${contact}</a></p><p><a href="${issues}">Public bug reports on GitHub</a></p></footer></body></html>`;
}
