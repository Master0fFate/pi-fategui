# Agents library and upgrade

The **Agents** sidebar replaces the old **Automations** tab. It stores three separate things:

- **Agent:** an identity, instructions, skills, model, and read-only or edit permission. Open its home conversation or start a new one.
- **TaskTemplate:** a reusable request. Run it with an enabled Agent.
- **Routine:** a project-scoped interval that binds one Agent to one TaskTemplate. It runs only while Fate UI is open; missed intervals are skipped, not replayed.

Open and trust a project, then select **Agents** in the sidebar. Create an Agent and a TaskTemplate before you run a task. To schedule future runs, create a Routine for that pair. Review **Run history** for results, failures, skipped runs, and actions that need attention. A Routine's time zone controls display; the schedule is interval-based, not a calendar appointment. Foreground conversations and Agent Team workflows remain available; see [Agent orchestration](agent-orchestration.md).

## Upgrade from Automations

**This is a workflow change, not an automatic migration.** The old Automations editor, direct launch action, and its renderer/IPC methods are removed in 1.1.0. Existing Automation documents remain on disk unchanged, but old Automations do not run or appear in the old tab.

1. Back up your project and Fate data before upgrading. Open the original project and trust it.
2. Go to **Agents → Copy Automations**. Select an old Automation and review its name, prompt, permission, and archived fields.
3. Confirm **Copy**. Fate creates one TaskTemplate and retains the original Automation file. Importing the same source again opens its existing copy; it does not make another one.
4. Create or choose an Agent. Run the copied TaskTemplate with that Agent. If you want scheduled execution, make a Routine explicitly; an old Automation is never turned into a scheduled run by itself.
5. If the copy is wrong, use **Roll back copy** on that TaskTemplate. This removes the copy, not the original file. If the source has changed since preview, refresh and review it again.

The import preserves the prompt and read-only/edit permission ceiling. Old launch counters, dates, and outcomes are archived with the copy, not turned into new Run history. Keep your backup until you confirm the new workflow works for your project. There is no one-click downgrade of a new Agent or Routine to the old Automations editor.

## Safety and limits

- Project trust and live permissions still apply. A saved definition or an approval cannot grant more authority than the current project and owner allow.
- Background work is limited to classified, project-confined tools. Shell commands, browser effects, image generation, unknown tools, and background delegation are unavailable. A consequential file action requires review of its exact input before it runs; interrupted or uncertain effects are not replayed automatically.
- A Git worktree is a separate checkout, **not** a security sandbox. Check the diff before you integrate or publish it.
- Local runs can contact your configured AI provider. The app does not promise to run a Routine while closed, offline, or after the computer sleeps.
