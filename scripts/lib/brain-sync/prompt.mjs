import readline from 'node:readline';

export async function prompt(question, { secret = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Private interactive input requires a terminal; never pass credentials in command arguments');
  process.stdout.write(`${question}: `);
  if (!secret) {
    const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await new Promise(resolve => interface_.question('', resolve)); } finally { interface_.close(); }
  }
  const wasRaw=process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=()=>{process.stdin.off('data',onData);process.stdin.setRawMode(wasRaw||false);process.stdin.pause();process.stdout.write('\n');};
    const onData=chunk=>{
      for(const character of chunk.toString()) {
        if(character==='\u0003') {finish();reject(new Error('Cancelled'));return;}
        if(character==='\r'||character==='\n') {finish();resolve(value);return;}
        if(character==='\u007f'||character==='\b') value=value.slice(0,-1);
        else if(character>=' ') value+=character;
      }
    };
    process.stdin.on('data',onData);
  });
}
