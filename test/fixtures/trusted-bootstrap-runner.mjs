// Isolated native-bootstrap fixture: no store, Git, model, or workspace action.
if (!process.argv.includes('--dispatch') || !process.argv.includes('--execution-instance')) {
  process.exitCode = 3;
} else {
  setTimeout(() => { process.exitCode = 0; }, 250);
}
