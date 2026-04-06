const fs = require('fs');
const js = fs.readFileSync('/data/user/0/com.ai.assistance.operit/files/workspace/74f14c9e-617f-42e7-80c4-d7ff2761e99f/js/main.js', 'utf8');
const match = js.match(/generator\.cells\.length/g);
console.log("Found generator.cells.length occurrences: " + (match ? match.length : 0));
