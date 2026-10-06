# BGMMix — AI 音乐共创平台（在线版）

路演网站 + 完整产品，全部在浏览器里运行，不需要服务器。音频只在访客自己的浏览器里处理，不会上传。

## 本地打开

`dsp-worker.js` 需要通过 http 加载，直接双击 index.html 时计算会退回主线程（能用，但处理时页面会卡几秒）。推荐：

```bash
cd BGMMix-Web
python -m http.server 8000      # 然后打开 http://localhost:8000
```

部署到任意静态托管（GitHub Pages、Vercel、Netlify、阿里云 OSS 等）时，上传整个文件夹即可。

## 结构

| 文件 | 作用 |
|---|---|
| `index.html` | 路演页面（01–06 章）+ LIVE 产品区 |
| `style.css` `pitch.css` `live-demo.css` `studio.css` | 样式 |
| `app.js` | 路演导航：章节高亮、方向键翻页 |
| `dsp-core.js` | DSP 引擎：FFT、Analyzer（BPM/调性/能量/情绪/段落）、四轨分离、WSOLA 变速不变调、WAV/ZIP 编码 |
| `dsp-worker.js` | 在后台线程运行分析、分离和变速 |
| `studio.js` | 产品：Orchestrator / Analyzer / Planner / Producer 四个 Agent、RemixPlan、Web Audio 渲染、A/B 试听、导出 |
| `dsp.test.js` | DSP 引擎测试：`node dsp.test.js` |

## Agent 分工

- **Orchestrator**：串联流程、管理状态
- **Analyzer**：测速度、调性、能量、响度、情绪、段落，并做四轨分离（谐波/打击乐中值滤波 + 低频贝斯 + 中置声像人声；四个掩膜相加恒等于 1，所以四轨相加严格还原原曲）
- **Planner**：把一句话意图变成结构化 RemixPlan。在 Claude 网页里打开时由 Claude 生成；其他环境使用本地关键词规则
- **Producer**：校验参数范围、跳过用户锁定的参数、记录每处修改和原因，再用 Web Audio OfflineAudioContext 渲染（EQ、饱和、混响、声场、黑胶、磁带摇晃、数字颗粒、泵感、按 BPM 对齐的鼓机）

## 6 个风格配方

LO-FI · CINEMATIC · HIGH ENERGY · DREAMY · RETRO 80s · UNPLUGGED

## 能力边界

- 四轨分离是轻量 DSP 算法，效果弱于 Demucs 等深度模型；单声道音源的人声分离更粗糙
- 长于约 3 分 20 秒的歌曲，分离采样率会降到 22.05 kHz 以节省内存
- 逐段自动化、旋律级重写属于下一阶段
