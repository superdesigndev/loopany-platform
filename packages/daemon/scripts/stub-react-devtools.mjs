// Stub for ink's DEV-only react-devtools-core bridge: the shipped TUI chunk
// never runs with process.env.DEV, so the real package is dead weight.
export default { connectToDevTools() {}, initialize() {} };
export const connectToDevTools = () => {};
