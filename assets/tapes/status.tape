# Render from the repo root: vhs assets/tapes/check.tape
Output "/tmp/specify-status.gif"

Set Shell bash
Set FontSize 15
Set Width 860
Set Height 600
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `alias specify="bun $(pwd)/src/cli.ts" && rm -rf /tmp/specify-demo && mkdir -p /tmp/specify-demo && cd /tmp/specify-demo && export HOME=/tmp/specify-demo`
Enter
Type `specify init my-app --integration claude --non-interactive >/dev/null 2>&1 && cd my-app`
Enter
Sleep 2s
Type "export PS1='> ' && clear"
Enter
Show

Type "specify status"
Sleep 300ms
Enter
Sleep 1.5s
Screenshot assets/status.png
