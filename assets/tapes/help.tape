# Render from the repo root: vhs assets/tapes/help.tape
Output "/tmp/specify-help.gif"

Set Shell bash
Set FontSize 15
Set Width 760
Set Height 780
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `alias specify="bun $(pwd)/src/cli.ts" && rm -rf /tmp/specify-demo && mkdir -p /tmp/specify-demo && cd /tmp/specify-demo && export HOME=/tmp/specify-demo`
Enter

Type "export PS1='> ' && clear"
Enter
Show

Type "specify --help"
Sleep 300ms
Enter
Sleep 1s
Screenshot assets/help.png
