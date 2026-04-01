const fs = require('node:fs');
function someAsyncOperation(callback) {
  // Assume this takes 95ms to complete
  fs.readFile('./empty.txt', callback);
}
// const timeoutScheduled = Date.now();
setTimeout(() => {
  console.log('timer')
}, 0);
// do someAsyncOperation which takes 95 ms to complete
someAsyncOperation(() => {
  console.log('read the empty file');
});