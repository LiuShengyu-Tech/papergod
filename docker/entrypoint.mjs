// Container entrypoint. Listens on all interfaces inside the container
// (docker-compose.yml publishes the port on the host's 127.0.0.1 only) and
// opens, in order of preference: explicit arguments, PAPERGOD_WORKSPACE, or
// the paper last selected in the app (--resume; the demo on first start).
// Written in Node rather than sh so Windows line endings cannot break it.
const args = process.argv.slice(2);
const start = args.length ? args
  : process.env.PAPERGOD_WORKSPACE ? [process.env.PAPERGOD_WORKSPACE]
    : ['--resume'];

process.argv = [process.argv[0], '/app/src/cli.js', '--host', '0.0.0.0', '--port', '3000', ...start];
await import('/app/src/cli.js');
