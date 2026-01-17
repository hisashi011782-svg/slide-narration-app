// スライドナレーションアプリ - バックエンドサーバー
// Gemini 3 Flash + Puppeteer 統合

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.')); // 静的ファイル配信

// Gemini API 初期化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ヘルスチェック
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'スライドナレーションAPI is running',
        geminiConfigured: !!process.env.GEMINI_API_KEY
    });
});

// スライド解析エンドポイント（単一スライド）
app.post('/api/analyze-slide', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URLが必要です' });
    }

    let browser = null;
    
    try {
        console.log(`📖 スライド解析開始: ${url}`);
        
        // Puppeteer でページ内容を取得
        browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 2000)); // 追加待機
        
        // ページのテキストコンテンツを取得
        const textContent = await page.evaluate(() => {
            // 不要な要素を除外
            const excludeSelectors = ['script', 'style', 'nav', 'header', 'footer'];
            excludeSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            });
            
            return document.body.innerText;
        });
        
        await browser.close();
        browser = null;
        
        console.log(`✅ テキスト取得完了: ${textContent.length} 文字`);
        
        // Gemini 3 Flash でナレーション生成
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-1.5-flash',
            generationConfig: {
                temperature: 0.9,
                maxOutputTokens: 1000,
            }
        });
        
        const prompt = `
あなたはプロのプレゼンテーターです。以下のスライド内容から、自然で魅力的なナレーション原稿を日本語で作成してください。

【要件】
- 150-300文字程度
- ビジネスカジュアルな口調
- 敬体（です・ます調）
- 句読点を適切に入れる
- 専門用語は分かりやすく説明
- 前置きや挨拶は不要（内容に直接入る）

【スライド内容】
${textContent.substring(0, 2000)}

【出力形式】
ナレーション原稿のみを出力してください。前置きや説明は不要です。
`;

        const result = await model.generateContent(prompt);
        const narration = result.response.text().trim();
        
        console.log(`🎤 ナレーション生成完了: ${narration.length} 文字`);
        
        res.json({
            success: true,
            narration,
            textLength: textContent.length,
            narrationLength: narration.length
        });
        
    } catch (error) {
        console.error('❌ エラー:', error.message);
        
        if (browser) {
            await browser.close();
        }
        
        res.status(500).json({
            error: 'スライド解析に失敗しました',
            message: error.message
        });
    }
});

// バッチ解析エンドポイント（複数スライド）
app.post('/api/analyze-slides-batch', async (req, res) => {
    const { url, slideCount } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URLが必要です' });
    }

    let browser = null;
    
    try {
        console.log(`📖 バッチ解析開始: ${url} (推定${slideCount || '不明'}枚)`);
        
        // Puppeteer でページ全体を取得
        browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // スライド要素を検出
        const slides = await page.evaluate(() => {
            // Gensparkスライドの構造を検出
            const slideSelectors = [
                'section',
                '[class*="slide"]',
                '[class*="page"]',
                'article',
                '.swiper-slide'
            ];
            
            let slideElements = [];
            
            for (const selector of slideSelectors) {
                const elements = Array.from(document.querySelectorAll(selector));
                if (elements.length > 0) {
                    slideElements = elements;
                    break;
                }
            }
            
            if (slideElements.length === 0) {
                // フォールバック: ページ全体を1スライドとして扱う
                return [{ text: document.body.innerText, index: 0 }];
            }
            
            return slideElements.map((el, idx) => ({
                text: el.innerText,
                index: idx
            })).filter(slide => slide.text.trim().length > 20);
        });
        
        await browser.close();
        browser = null;
        
        console.log(`✅ ${slides.length} 枚のスライドを検出`);
        
        // Gemini でナレーション生成（バッチ処理）
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-1.5-flash',
            generationConfig: {
                temperature: 0.9,
                maxOutputTokens: 2000,
            }
        });
        
        const narrations = [];
        
        for (let i = 0; i < Math.min(slides.length, 50); i++) {
            const slide = slides[i];
            
            const prompt = `
あなたはプロのプレゼンテーターです。以下のスライド内容から、自然で魅力的なナレーション原稿を日本語で作成してください。

【スライド番号】
${i + 1}枚目

【要件】
- 150-250文字程度
- ビジネスカジュアルな口調
- 敬体（です・ます調）
- 句読点を適切に入れる
- ${i === 0 ? '導入として簡潔に始める' : i === slides.length - 1 ? '締めくくりの言葉を含める' : '内容を分かりやすく説明する'}

【スライド内容】
${slide.text.substring(0, 1500)}

【出力形式】
ナレーション原稿のみを出力してください。前置きや説明は不要です。
`;

            try {
                const result = await model.generateContent(prompt);
                const narration = result.response.text().trim();
                narrations.push(narration);
                console.log(`🎤 スライド${i + 1}/${slides.length}: ${narration.length}文字`);
                
                // レート制限対策
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`❌ スライド${i + 1}の生成失敗:`, error.message);
                narrations.push(`スライド${i + 1}の内容を説明します。`);
            }
        }
        
        console.log(`✅ バッチ生成完了: ${narrations.length}件`);
        
        res.json({
            success: true,
            narrations,
            slideCount: slides.length,
            generatedCount: narrations.length
        });
        
    } catch (error) {
        console.error('❌ バッチ処理エラー:', error.message);
        
        if (browser) {
            await browser.close();
        }
        
        res.status(500).json({
            error: 'バッチ解析に失敗しました',
            message: error.message
        });
    }
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
    console.log(`🔑 Gemini API: ${process.env.GEMINI_API_KEY ? '設定済み ✅' : '未設定 ❌'}`);
});
