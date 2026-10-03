# Render from the repo root: vhs assets/tapes/init.tape
Output assets/init.gif

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `alias specify="bun $(pwd)/src/cli.ts" && rm -rf /tmp/specify-demo && mkdir -p /tmp/specify-demo && cd /tmp/specify-demo && export HOME=/tmp/specify-demo`
Enter
Type `git config --global user.name demo && git config --global user.email demo@example.com && git config --global init.defaultBranch main`
Enter
Type "export PS1='> ' && clear"
Enter
Show

Type "specify init my-app --integration claude"
Sleep 400ms
Enter
Sleep 2.2s
Down
Sleep 600ms
Up
Sleep 600ms
Enter
Sleep 4s
