Enter the existing tmux session:
`tmux attach -t ntf-to-agenda`
or create a new one:
`tmux new -s ntf-to-agenda`
Initiate the application:
`node index.mjs > >(tee output.log) 2> >(tee errors.log >&2)`
This makes sure output and errors are also logged to output.log and error.log respectively.
Follow the instructions as specified by the application.
Then, leave the tmux session by pressing Ctrl+B and then D. The process is now running in the background.
