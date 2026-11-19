/** Matching runs outside the UI thread, with a hard timeout and no generated code execution. */
export function testAgentRegex({ pattern, flags = '', text, signal }) {
    if (typeof pattern !== 'string' || typeof text !== 'string' || pattern.length > 10000 || text.length > 100000) {
        return Promise.reject(new Error('正则模式限10000字符，测试文本限100000字符'));
    }
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Agent已停止'), { name: 'AbortError' }));
    if (typeof Worker !== 'function') return Promise.reject(new Error('当前环境不支持隔离Worker，未执行正则测试'));
    const code = `self.onmessage=function(event){try{var d=event.data,re=new RegExp(d.pattern,d.flags),matches=[],m;if(!re.global&&!re.sticky){m=re.exec(d.text);if(m)matches.push({index:m.index,match:m[0],groups:Array.from(m).slice(1),namedGroups:m.groups||null})}else{while((m=re.exec(d.text))&&matches.length<100){matches.push({index:m.index,match:m[0],groups:Array.from(m).slice(1),namedGroups:m.groups||null});if(m[0]==='')re.lastIndex++}}self.postMessage({ok:true,matches:matches,limited:matches.length>=100})}catch(e){self.postMessage({ok:false,error:e.message})}}`;
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        let worker;
        try { worker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); reject(error); return; }
        const finish = (error, result) => {
            clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); URL.revokeObjectURL(url);
            if (error) reject(error); else resolve(result);
        };
        const cancel = () => finish(Object.assign(new Error('Agent已停止'), { name: 'AbortError' }));
        const timer = setTimeout(() => finish(new Error('正则测试超过1000毫秒已终止，请简化表达式')), 1000);
        worker.onmessage = ({ data }) => data?.ok ? finish(null, data) : finish(new Error(data?.error || '正则测试失败'));
        worker.onerror = () => finish(new Error('正则测试Worker失败'));
        signal?.addEventListener('abort', cancel, { once: true });
        worker.postMessage({ pattern, flags, text });
    });
}
