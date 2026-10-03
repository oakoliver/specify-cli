# Render from the repo root: vhs assets/tapes/picker.tape
# A bare `specify init` in an 80x24 terminal: the integration picker scrolls.
Output assets/picker.gif

Set Shell bash
Set FontSize 14
Set Width 782
Set Height 432
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `alias specify="BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun $(pwd)/src/cli.ts" && rm -rf /tmp/specify-demo && mkdir -p /tmp/specify-demo && cd /tmp/specify-demo && export HOME=/tmp/specify-demo`
Enter
Type `git config --global user.name demo && git config --global user.email demo@example.com && git config --global init.defaultBranch main`
Enter
Type "export PS1='> ' && clear"
Enter
Show

Type "specify init my-app"
Sleep 400ms
Enter
Sleep 4s
Down@150ms 8
Sleep 1.2s
Up@150ms 13
Sleep 1.5s
Enter
Sleep 2s
Enter
Sleep 4s
