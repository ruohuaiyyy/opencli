import XLSX from 'xlsx';

const wb = XLSX.readFile('D:/Users/wenjiewj.han/Downloads/今日头条来源URL汇总_豆包AI生成_结果.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, {header:1});

const names = {};
for(let i=1; i<data.length; i++) {
  const name = data[i][1];
  const followers = data[i][2];
  const auth = data[i][3];
  if (name && name !== '获取失败') {
    if (!names[name]) {
      names[name] = { count: 0, followers: followers, auth: auth };
    }
    names[name].count++;
  }
}

const sorted = Object.entries(names).sort((a,b) => b[1].count - a[1].count).slice(0, 100);
for(let i=0; i<sorted.length; i++) {
  const [name, info] = sorted[i];
  console.log(`${i+1}. ${name} | 文章数: ${info.count} | 粉丝: ${info.followers} | 认证: ${info.auth}`);
}