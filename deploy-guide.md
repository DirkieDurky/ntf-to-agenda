Enter the existing tmux session:
`tmux attach -t ntf-to-agenda`
or create a new one:
`tmux new -s ntf-to-agenda`
Initiate the application:
`node index.mjs 2>&1 | tee output.log`
This makes sure output and errors are also logged to output.log.
Then, leave the tmux session by pressing Ctrl+B and then D. The process is now running in the background.
