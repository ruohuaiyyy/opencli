import XLSX from 'xlsx';
import path from 'path';

const filePath = 'D:\\Users\\wenjiewj.han\\Downloads\\今日头条来源URL汇总_豆包AI生成_结果.xlsx';
const wb = XLSX.readFile(filePath);
const wsName = wb.SheetNames[0];
const ws = wb.Sheets[wsName];

const data = XLSX.utils.sheet_to_json(ws);
console.log('原始数据行数:', data.length);

// 按 URL 去重，统计每个URL出现的次数
const urlCountMap = new Map();
const urlFirstRowMap = new Map();

for (const row of data) {
  const url = row['今日头条来源URL'];
  if (!url) continue;

  if (urlCountMap.has(url)) {
    urlCountMap.set(url, urlCountMap.get(url) + 1);
  } else {
    urlCountMap.set(url, 1);
    urlFirstRowMap.set(url, row);
  }
}

console.log('去重后文章数:', urlCountMap.size);

// 构建去重后的数据，添加"出现次数"列
const dedupData = [];
for (const [url, count] of urlCountMap) {
  const row = urlFirstRowMap.get(url);
  dedupData.push({
    '今日头条来源URL': url,
    '账号名': row['账号名'],
    '粉丝数': row['粉丝数'],
    '认证信息': row['认证信息'],
    'media_id': row['media_id'],
    '出现次数': count
  });
}

// 按出现次数降序排列
dedupData.sort((a, b) => b['出现次数'] - a['出现次数']);

console.log('出现次数 > 1 的文章数:', dedupData.filter(r => r['出现次数'] > 1).length);
console.log('出现次数最高的前5篇:');
dedupData.slice(0, 5).forEach(r => {
  console.log(`  ${r['出现次数']}次 - ${r['今日头条来源URL']} - ${r['账号名']}`);
});

// 生成新的 Excel
const newWs = XLSX.utils.json_to_sheet(dedupData);
const newWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(newWb, newWs, '去重结果');

const outputPath = 'D:\\Users\\wenjiewj.han\\Downloads\\今日头条来源URL汇总_豆包AI生成_去重结果.xlsx';
XLSX.writeFile(newWb, outputPath);
console.log('输出文件:', outputPath);
console.log('完成!');