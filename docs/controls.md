# Interface and controls

## General controls

```text
↑ / ↓       move through choices
Space       toggle or select the current option
Enter       select, toggle, continue, or submit an editor
Ctrl+Enter  insert a new line in the commit-message editor
Esc         go back
Tab         complete paths or switch Settings pane focus
Shift+Tab   move Settings focus backward
← / →       return from or open a Settings category
Page Up     scroll Activity upward
Page Down   scroll Activity downward
Home        move to the beginning where supported
End         return to the latest output
Ctrl+B      open or close global settings
Ctrl+T      toggle native terminal text selection
Ctrl+C      cancel the active operation; exit while idle
?           show context-sensitive help
```

Controls are context-sensitive. The active screen can expose additional actions in its footer or help overlay.

## Operation-aware cancellation

`Ctrl+C` behaves differently while Zipflow is idle and while it owns an active operation.

Idle screens include archive waiting, menus, history, and ordinary editors. On these screens, `Ctrl+C` exits Zipflow.

During archive inspection, LLM generation or decisions, checks, deployment, ZIP creation, storage scans, model operations, apply, or rollback:

1. the first `Ctrl+C` requests cancellation and keeps Zipflow open;
2. a second press while cancellation is still pending force-stops owned child processes but still does not exit;
3. after the operation reaches a stable screen, a later `Ctrl+C` exits normally.

Filesystem transactions defer interruption until the current atomic step can complete or be restored.

Cancelling an autonomous decision pauses autopilot for the current run and returns to the equivalent manual checkpoint. It can be resumed explicitly when the screen offers **Resume autopilot**.

## Context dock and help

Every action list reserves a stable one-line context dock below its choices. Moving between short and long descriptions does not change panel height. Long descriptions are clipped in the dock, while `?` opens the complete context-sensitive explanation.

The help toast wraps to the available terminal size, becomes scrollable when necessary, closes with a click or `Esc`, and expires automatically.

Editors use muted placeholders with a visible cursor so examples cannot be mistaken for entered text.

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

## Path completion

Path suggestions appear in an overlay without moving the surrounding layout.

- `Up` and `Down` select a suggestion.
- `Tab` or `Enter` inserts the selected suggestion.
- Selecting a ZIP fills the field but does not submit it.
- Press `Enter` again to confirm the completed path.
- Existing directories can expose **Use this directory** in directory pickers.

Archive and output-path editors share this behavior. Output paths add `.zip` when missing and ask separately before overwriting an existing destination.

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
Mouse wheel scroll the diff directly
```

Conflict review also exposes direct keep-local and use-archive shortcuts in the active footer. Every action remains available through the normal menu.

## Settings

Global settings retain the two-panel layout:

- compact categories on the left;
- the selected category page on the right.

`Tab` and `Shift+Tab` move focus between panes without activating the current item. `Enter` or `Space` opens or applies it. `Esc` returns one level while preserving the previous category and item selection.

Text, secret, path, and numeric values open in compact modal editors with validation and unit hints where applicable.
