# Render from the repo root: vhs assets/tapes/tree.tape
Output "/tmp/specify-tree.gif"

Set Shell bash
Set FontSize 14
Set Width 760
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `alias specify="bun $(pwd)/src/cli.ts" && rm -rf /tmp/specify-demo && mkdir -p /tmp/specify-demo && cd /tmp/specify-demo && export HOME=/tmp/specify-demo`
Enter
Type `specify init my-app --integration claude --non-interactive >/dev/null 2>&1`
Enter
Sleep 2s
Type "export PS1='> ' && clear"
Enter
Show

Type "tree -a -L 3 -I .git my-app"
Sleep 300ms
Enter
Sleep 1s
Screenshot assets/tree.png
