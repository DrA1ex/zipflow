# Interface and controls

## General controls

```text
↑ / ↓       move through choices
Space       toggle or select the current option
Enter       select, toggle, continue, or submit an editor
            press twice on an empty archive field to scan the last-used folder
Ctrl+Enter  insert a new line in the commit-message editor
Esc         go back
Tab         complete paths or switch Settings pane focus
Shift+Tab   move Settings focus backward
← / →       return from or open a Settings category
Page Up     move or scroll one page upward
Page Down   move or scroll one page downward
Home        move to the first item where supported
End         move to the last item or latest output
Ctrl+B      open or close global settings
Ctrl+T      toggle native terminal text selection
G           reveal the current run report where available
Ctrl+C      cancel the active operation; exit while idle
?           show context-sensitive help
```

Controls are context-sensitive. The active screen can expose additional actions in its footer or help overlay. Multiline clipboard paste is delivered to editors as one edit operation: embedded line breaks are preserved in the commit-message editor and never interpreted as separate submit keys. Editor submission and menu activation are single-flight, so repeated input cannot start overlapping Git operations.

## Operation-aware cancellation

`Ctrl+C` behaves differently while Zipflow is idle and while it owns an active operation.

Idle screens include archive waiting, menus, history, and ordinary editors. On these screens, `Ctrl+C` exits Zipflow.

During archive inspection, LLM generation or decisions, checks, deployment, ZIP creation, storage scans, model operations, apply, or rollback:

1. the first `Ctrl+C` requests cancellation and keeps Zipflow open;
2. a second press while cancellation is still pending force-stops owned child processes but still does not exit;
3. after the operation reaches a stable screen, a later `Ctrl+C` exits normally.

Filesystem transactions defer interruption until the current atomic step can complete or be restored. Zipflow intercepts the workspace-level `Ctrl+C` event before Terlio's default exit behavior so an owned operation always receives the cancellation request first.

Cancelling an autonomous decision pauses autopilot for the current run and returns to the equivalent manual checkpoint. It can be resumed explicitly when the screen offers **Resume autopilot**.

## Context dock and help

Workflow action lists render every choice as exactly one row. Descriptions are kept out of the list and shown in a stable context dock below it; workflow setup uses two context rows so longer explanations do not expand individual choices. Settings value pages use a compact two-line dock: the first line explains the parameter and the second explains the selected value. Moving between short and long descriptions does not change panel height. Long descriptions are clipped in the dock, while `?` opens the complete context-sensitive explanation.

The global footer is an untitled key-hint bar. It may include a short contextual value on the right, but it is not presented as a separate status panel.

Context help opens as a native blocking Terlio overlay with the active accent, background dimming, and shadow. It wraps to the available terminal size, becomes scrollable when necessary, and closes with a click or `Esc`. Transient notifications use Zipflow's adaptive toast overlay: width follows the content within terminal bounds, detail text wraps, the tail is preserved, and clicking dismisses the notification.

Editors use muted placeholders with a visible cursor so examples cannot be mistaken for entered text.


## Active-list navigation

When Change Workflow, workflow setup, a checks list, policy list, file list, run history, run details, analytics, or another paged choice list has focus, `Page Up`, `Page Down`, `Home`, and `End` navigate that list instead of Activity. Run-history panels expand according to their content: small menus remain compact, while larger history screens expose up to sixteen rows when terminal height permits.

When a run report exists, press `G` to reveal it in the platform file manager. On macOS the report itself is selected; on Linux Zipflow opens its containing directory.

## Activity

Activity entries use stable roles:

```text
INFO  general information
RUN   active work
DONE  completed work
WARN  warnings
FAIL  failures
YOU   user decisions
SUM   final summaries
```

Structured keys such as `Assessment`, `Confidence`, `Delivery`, and `Patch coverage` use the active accent. Short generated coverage blocks remain expanded. Other durable blocks longer than three lines begin collapsed, except project discovery and the final summary.

Scroll to a block and press `E` to expand or collapse it. Large logs use viewport rendering and a cached transcript so reading long outputs does not repeatedly rewrap and recolor the complete block.

When new entries arrive while older content is being read, Zipflow displays a prominent indicator. Click it or press `End` to return to the latest entry.

In-app drag selection remains available while pointer controls are active. Click an existing highlight to copy it. `Ctrl+T` temporarily restores the terminal emulator's native selection mode for other UI regions.

## Recent archive discovery

While the archive-path field is empty, the first `Enter` arms discovery and shows the exact remembered folder. Press `Enter` again within 1.5 seconds to scan that folder. Zipflow considers only `.zip` files modified during the previous 24 hours, reads their central directories without extraction, and offers only candidates whose internal project paths substantially overlap the current project. Selecting a candidate starts the normal archive security inspection. `Tab` continues to show the explicit recent-path list.

If no archive folder has been remembered yet, the shortcut explains that one normal ZIP selection is required first.

## Path completion

Path suggestions appear in an overlay without moving the surrounding layout.

- `Up` and `Down` select a suggestion.
- `Tab` or `Enter` inserts the selected suggestion.
- Selecting a ZIP fills the field but does not submit it.
- Press `Enter` again to confirm the completed path.
- Existing directories can expose **Use this directory** in directory pickers.

Archive and output-path editors share this behavior. Project-path editors complete workspace-relative directories. In custom check and deployment editors, completion applies before `::`; selecting `web/` inserts `web/ :: ` so the shell command can be entered immediately afterward. Output paths add `.zip` when missing and ask separately before overwriting an existing destination.

## Diff review

Text changes can use unified or side-by-side display depending on terminal width.

Common diff controls include:

```text
N or ]      next hunk
P or [      previous hunk
Page Up     scroll upward
Page Down   scroll downward
Home        first line
End         last line
Mouse wheel moves the active surface by exactly one row and stops at list boundaries
```

Conflict review also exposes direct keep-local and use-archive shortcuts in the active footer. Every action remains available through the normal menu.

## Settings

Global settings retain the two-panel layout:

- compact categories on the left;
- the selected category page on the right.

`Tab` and `Shift+Tab` move focus between panes without activating the current item. `Enter` or `Space` opens or applies it. `Esc` returns one level while preserving the previous category and item selection.

Text, secret, path, and numeric values open in compact modal editors with validation and unit hints where applicable.
