import XLSX from 'xlsx';

const wb = XLSX.readFile('D:/Users/wenjiewj.han/Downloads/今日头条来源URL汇总_豆包AI生成_结果.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, {header:1});
console.log('Total rows:', data.length);
console.log('Header:', JSON.stringify(data[0]));
console.log('');

// Show first 5 data rows
for(let i=1; i<6; i++) {
  console.log('Row ' + i + ':', JSON.stringify(data[i]));
}
console.log('');

// Count unique account names
const names = {};
let emptyCount = 0;
let failCount = 0;
for(let i=1; i<data.length; i++) {
  const name = data[i][1];
  if (!name || name === '') emptyCount++;
  else if (name === '获取失败') failCount++;
  else names[name] = (names[name]||0) + 1;
}
console.log('Unique accounts:', Object.keys(names).length);
console.log('Empty names:', emptyCount);
console.log('Failed:', failCount);
console.log('');

// Top 10 accounts
const sorted = Object.entries(names).sort((a,b) => b[1]-a[1]).slice(0,10);
console.log('Top 10 accounts:');
for(const [name, count] of sorted) {
  console.log('  ' + name + ': ' + count + ' articles');
}