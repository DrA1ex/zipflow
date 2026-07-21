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
Ctrl+C      stop safely and terminate active child processes
?           show context-sensitive help
```

Controls are context-sensitive. The active screen can expose additional actions in its footer or help overlay.

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

Durable blocks longer than three lines begin collapsed, except project discovery and the final summary. Scroll to a block and press `E` to expand or collapse it.

When new entries arrive while older content is being read, Zipflow displays a prominent indicator. Click it or press `End` to return to the latest entry.

In-app drag selection remains available while pointer controls are active. Click an existing highlight to copy it. `Ctrl+T` temporarily restores the terminal emulator's native selection mode for other UI regions.

## Path completion

Path suggestions appear in an overlay without moving the surrounding layout.

- `Up` and `Down` select a suggestion.
- `Tab` or `Enter` inserts the selected suggestion.
- Selecting a ZIP fills the field but does not submit it.
- Press `Enter` again to confirm the completed path.
- Existing directories can expose **Use this directory** in directory pickers.

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
