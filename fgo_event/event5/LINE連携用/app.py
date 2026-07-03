"""
FGO Event Farming Optimizer — LINE Bot Server

ゲーム画面のスクリーンショットをLINEに送信すると、
Gemini APIで画像認識を行い、最適な周回プランを自動計算して返答するボット。
テキストコマンドによるパラメータのリアルタイム更新にも対応。

技術スタック: Python / Flask / LINE Messaging API / Google Gemini API
デプロイ先: PythonAnywhere
"""

import os
import tempfile
import json
import yaml
from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, ImageMessage, TextMessage, TextSendMessage
from google import genai
from google.genai import types

from calc_efficiency import load_config, run_for_line

app = Flask(__name__)

# --- APIキーの設定 ---
# 環境変数で設定されていない場合は、以下の '...' の部分に直接キーを貼り付けてください。
LINE_ACCESS_TOKEN = os.environ.get('LINE_ACCESS_TOKEN', 'ここにLINE_ACCESS_TOKENを貼り付け')
LINE_CHANNEL_SECRET = os.environ.get('LINE_CHANNEL_SECRET', 'ここにLINE_CHANNEL_SECRETを貼り付け')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', 'ここにGEMINI_API_KEYを貼り付け')

line_bot_api = LineBotApi(LINE_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)
client = genai.Client(api_key=GEMINI_API_KEY)

@app.route("/callback", methods=['POST'])
def callback():
    signature = request.headers['X-Line-Signature']
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)
    return 'OK'

# ---------------------------------------------------
# 追加：テキスト（コマンド）が送られてきた時の処理
# ---------------------------------------------------
@handler.add(MessageEvent, message=TextMessage)
def handle_text(event):
    text = event.message.text.strip()
    parts = text.split() # スペースで分割
    
    # 3単語以上のコマンド形式でなければ何もしない（無視する）
    if len(parts) < 3:
        return 
        
    cmd = parts[0]
    if cmd not in ["所持", "必要", "礼装"]:
        return 
        
    script_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(script_dir, '..', 'config.yaml')
    if not os.path.exists(config_path):
        config_path = os.path.join(script_dir, 'config.yaml')
    config = load_config(config_path)
    
    try:
        msg = ""
        # 1. 素材の所持・必要数の変更
        if cmd == "所持" or cmd == "必要":
            key_map = {"所持": "owned", "必要": "needed"}
            mat_map = {"金": "gold", "銀": "silver", "銅": "copper"}
            
            mat = mat_map.get(parts[1])
            val = int(parts[2])
            key = key_map[cmd]
            
            if mat:
                config['materials'][mat][key] = val
                msg = f"✅ {parts[1]}素材の{cmd}数を {val} に更新しました！"
                
        # 2. 礼装の変更 (例: 礼装 ポイント 未進化 5)
        elif cmd == "礼装" and len(parts) == 4:
            cat_map = {"金": "gold", "銀": "silver", "銅": "copper", "ポイント": "point"}
            type_map = {"未進化": "normal", "進化": "evolved"}
            
            cat = cat_map.get(parts[1])
            evo = type_map.get(parts[2])
            val = int(parts[3])
            
            if cat and evo:
                config['loadout']['self'][cat][evo] = val
                msg = f"✅ {parts[1]}礼装（{parts[2]}）の所持数を {val} に更新しました！"
                
        # ポイントコマンド削除

        # 書き換えに成功した場合、ファイルに上書き保存して返信
        if msg:
            with open(config_path, 'w', encoding='utf-8') as f:
                yaml.dump(config, f, allow_unicode=True, default_flow_style=False)
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=msg))
        else:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="⚠️ コマンドの形式または種類が間違っています。"))
            
    except ValueError:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text="⚠️ 数値の部分には半角数字を入力してください。"))
    except Exception as e:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"エラーが発生しました: {str(e)}"))

# ---------------------------------------------------
# 既存：画像（スクショ）が送られてきた時の処理
# ---------------------------------------------------
@handler.add(MessageEvent, message=ImageMessage)
def handle_image(event):
    message_id = event.message.id
    message_content = line_bot_api.get_message_content(message_id)
    
    with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tf:
        for chunk in message_content.iter_content():
            tf.write(chunk)
        temp_path = tf.name

    try:
        myfile = client.files.upload(file=temp_path)
        prompt = """
        このゲーム画面のスクリーンショットから、現在の素材の所持数を読み取ってください。
        画像のレイアウトや配置ではなく、必ず「アイコンの見た目」で判断してください：
        - copper: 銅素材のアイコンの数値
        - silver: 銀素材のアイコンの数値
        - gold: 金素材のアイコンの数値
        カンマなどは除外し、純粋な整数のみを出力してください。
        必ず以下のJSONフォーマットのみを出力してください:
        {"copper": 1438, "silver": 1456, "gold": 1738}
        """
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[myfile, prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        
        data = json.loads(response.text)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        config_path = os.path.join(script_dir, '..', 'config.yaml')
        if not os.path.exists(config_path):
            config_path = os.path.join(script_dir, 'config.yaml')
        config = load_config(config_path) 
        
        # point 削除
        config['materials']['copper']['owned'] = data.get('copper', config['materials']['copper']['owned'])
        config['materials']['silver']['owned'] = data.get('silver', config['materials']['silver']['owned'])
        config['materials']['gold']['owned'] = data.get('gold', config['materials']['gold']['owned'])
        
        result_text = run_for_line(config)
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=result_text))
        
    except Exception as e:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"エラーが発生しました: {str(e)}"))
    finally:
        os.remove(temp_path)

if __name__ == "__main__":
    app.run(port=8000)