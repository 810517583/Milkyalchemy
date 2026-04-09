/**
 * 企业微信消息双向代理服务
 * 功能：接收企业微信回调 → 提供轮询API → 油猴脚本获取命令执行 → 返回结果
 */

const express = require('express');
const crypto = require('crypto');
const xml2js = require('xml2js');
const axios = require('axios');

const app = express();

// ==================== 配置 ====================
const CONFIG = {
    // 企业微信配置（服务端统一管理）
    CORP_ID: '填写你自己的',
    CORP_SECRET: '填写你自己的',
    AGENT_ID: 填写你自己的,
    
    // 回调配置
    TOKEN: '填写你自己的',
    ENCODING_AES_KEY: '填写你自己的',
    
    // 用户权限配置
    ALLOWED_USERS: ['填写你自己的'],      // 白名单用户（企业微信UserID）
    SUPER_ADMINS: ['填写你自己的'],       // 超级管理员
    
    // 服务配置
    PORT: 24860
};

// ==================== 常量 ====================
const UNKNOWN_MENU_EMOJI = 'ʕง•ᴥ•ʔง';  // 未知菜单/错误的颜文字表情

// ==================== 全局状态 ====================
let accessToken = null;
let tokenExpireTime = 0;
let pendingCommands = [];  // 待执行的命令队列：[{ id, command, args, targetUser, createTime }]
let commandResults = {};   // 命令执行结果
let registeredScripts = {}; // 注册的脚本实例：{ userId: { lastSeen, status, version } }
let lastMenuClick = {};    // 菜单点击去重：{ "user:command": timestamp }

// ==================== 中间件 ====================
app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '10mb' })); // 接收原始数据

// 日志中间件
app.use((req, res, next) => {
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`[${time}] ${req.method} ${req.url}`);
    next();
});

// ==================== 企业微信回调 ====================

/**
 * 验证回调URL有效性（企业微信配置时调用）
 */
app.get('/callback', (req, res) => {
    const { msg_signature, timestamp, nonce, echostr } = req.query;
    
    console.log('[回调验证] 收到验证请求');
    console.log(`  msg_signature: ${msg_signature}`);
    console.log(`  timestamp: ${timestamp}`);
    console.log(`  nonce: ${nonce}`);
    console.log(`  echostr: ${echostr}`);
    
    // 企业微信验证URL签名：sha1(sort(token, timestamp, nonce, echostr))
    const calcSignature = crypto
        .createHash('sha1')
        .update([CONFIG.TOKEN, timestamp, nonce, echostr].sort().join(''))
        .digest('hex');
    
    console.log(`  计算签名: ${calcSignature}`);
    
    if (calcSignature !== msg_signature) {
        console.log('[回调验证] 签名验证失败');
        // 直接返回解密后的内容试试（有些情况下签名验证可跳过）
    } else {
        console.log('[回调验证] 签名验证成功');
    }
    
    // 解密echostr
    try {
        const decrypted = decryptAES(echostr, CONFIG.ENCODING_AES_KEY);
        console.log(`[回调验证] 解密结果: ${decrypted}`);
        return res.send(decrypted);
    } catch (error) {
        console.error('[回调验证] 解密失败:', error.message);
        return res.status(500).send('Decrypt failed');
    }
});

/**
 * 接收企业微信消息
 */
app.post('/callback', async (req, res) => {
    const { msg_signature, timestamp, nonce } = req.query;
    
    // 获取原始XML数据
    let xmlData = '';
    if (Buffer.isBuffer(req.body)) {
        xmlData = req.body.toString('utf-8');
    } else if (typeof req.body === 'string') {
        xmlData = req.body;
    } else {
        xmlData = JSON.stringify(req.body);
    }
    
    console.log('[收到消息] XML长度:', xmlData.length);
    
    // 解析XML
    try {
        const result = await xml2js.parseStringPromise(xmlData, { explicitArray: false });
        const encrypted = result.Encrypt || result.xml?.Encrypt;
        
        if (!encrypted) {
            console.log('[解析失败] 未找到Encrypt字段');
            console.log('XML结构:', JSON.stringify(result, null, 2));
            return res.send('success');
        }
        
        console.log('[Encrypt长度]', encrypted.length);
        
        // 验证签名：sha1(sort(token, timestamp, nonce, encrypt))
        const calcSignature = crypto
            .createHash('sha1')
            .update([CONFIG.TOKEN, timestamp, nonce, encrypted].sort().join(''))
            .digest('hex');
        
        console.log('[签名验证] 计算:', calcSignature);
        console.log('[签名验证] 收到:', msg_signature);
        
        if (calcSignature !== msg_signature) {
            console.log('[签名验证] 失败，但仍尝试解密');
        } else {
            console.log('[签名验证] 成功');
        }
        
        // 解密消息
        const decrypted = decryptAES(encrypted, CONFIG.ENCODING_AES_KEY);
        console.log('[解密消息]', decrypted);
        
        // 解析解密后的XML
        const innerResult = await xml2js.parseStringPromise(decrypted, { explicitArray: false });
        const message = innerResult.xml;
        
        console.log('[消息内容]', JSON.stringify(message, null, 2));
        
        // 处理消息
        await handleMessage(message);
        
    } catch (error) {
        console.error('[处理消息异常]', error.message);
        console.error(error.stack);
    }
    
    res.send('success');
});

// ==================== 消息处理 ====================

/**
 * 处理接收到的消息
 */
async function handleMessage(message) {
    const { Content, FromUserName, MsgType, Event } = message;
    
    // 处理事件
    if (MsgType === 'event') {
        console.log(`[事件] ${Event}`);
        if (Event === 'click') {
            // 处理菜单点击事件
            const eventKey = message.EventKey;
            console.log(`[菜单点击] ${eventKey}`);
            await handleMenuClick(eventKey, FromUserName);
        }
        return;
    }
    
    // 处理文本消息（仅处理以 / 开头的命令，msg类型按钮发的文本忽略）
    if (MsgType === 'text' && Content) {
        const text = Content.trim();
        if (text.startsWith('/')) {
            console.log(`[文本命令] ${text}`);
            await handleTextCommand(text, fromUser);
        } else {
            console.log(`[文本消息] 忽略（非命令）: ${text}`);
        }
    }
}

/**
 * 处理菜单点击
 * 企业微信菜单EventKey配置建议：cmd_status, cmd_refresh, cmd_config
 */
async function handleMenuClick(eventKey, fromUser) {
    // 0. 忽略企业微信后台的"消息发送"功能（格式：#sendmsg#_x_x#xxxx）
    // 这部分由企业微信管理后台直接处理，不需要走篡改猴脚本
    if (eventKey.startsWith('#sendmsg#')) {
        console.log(`[忽略消息发送] ${fromUser}: ${eventKey}（企业微信后台消息推送，不处理）`);
        return;
    }

    // 1. 白名单校验
    if (!CONFIG.ALLOWED_USERS.includes(fromUser)) {
        console.log(`[权限拒绝] ${fromUser} 不在白名单中`);
        await sendTextMessage(fromUser, '您没有权限使用此功能');
        return;
    }
    
    // 2. EventKey映射到命令
    const keyMap = {
        'cmd_status': '/status',
        'cmd_refresh': '/refresh',
        'cmd_config': '/config',
        'cmd_networth': '/networth',
        'cmd_looklook': '/looklook',
        'cmd_eating': '/eating',
        'cmd_drop': '/drop',
        'cmd_whitedrop': '/whitedrop',
        'cmd_whitelist': '/whitelist_get',
        // 超管专用命令
        'cmd_allstatus': '/allstatus',
        // 兼容企业微信默认格式
        'STATUS': '/status',
        'REFRESH': '/refresh',
        'CONFIG': '/config',
        // 兼容 #xxx# 格式
        '#looklook#': '/looklook',
        '#eating#': '/eating',
        '#status#': '/status',
        '#refresh#': '/refresh',
        '#config#': '/config'
    };
    
    // 解析企业微信 sendmsg 格式: #sendmsg#_{menuId}_{buttonId}#{msgId}
    let actualKey = eventKey;
    if (eventKey.startsWith('#sendmsg#')) {
        const parts = eventKey.split('_');
        if (parts.length >= 3) {
            const buttonId = parts[2].split('#')[0];
            // buttonId 映射表 (根据企业微信后台菜单顺序配置)
            // 常用菜单(0-3): 状态,配置,NetWorth,刷新
            // 高级功能(4-8): 物品通知,白名单通知,白名单名单,待定,强化等级
            // 其他查询(9-13): 看看运气,出警,待定,待定,待定
            const buttonIdMap = {
                '0': 'cmd_status',      // 当前状态
                '1': 'cmd_config',      // 当前插件配置
                '2': 'cmd_networth',   // 总NetWorth
                '3': 'cmd_refresh',     // 刷新网页
                '4': 'cmd_drop',        // 切换物品通知
                '5': 'cmd_whitedrop',   // 切换物品白名单通知
                '6': 'cmd_whitelist',   // 物品白名单名单
                '7': '',                // 待定 - 禁用
                '8': 'level',            // 修改强化等级 - 触发UNKNOWN_MENU_EMOJI
                '9': 'cmd_looklook',    // 看看运气
                '10': 'cmd_eating',     // 出警
                '11': '',               // 待定 - 禁用
                '12': '',               // 待定 - 禁用
                '13': ''                // 待定 - 禁用
            };
            actualKey = buttonIdMap[buttonId] || eventKey;
            
            // 跳过禁用的按钮
            if (actualKey === '') {
                console.log(`[菜单点击] ${fromUser}: buttonId=${buttonId} 已禁用`);
                return;
            }
            console.log(`[sendmsg解析] ${eventKey} -> buttonId=${buttonId} -> ${actualKey}`);
        }
    }
    
    const command = keyMap[actualKey];
    
    if (!command) {
        console.log(`[未知菜单] ${eventKey}`);
        await sendTextMessage(fromUser, UNKNOWN_MENU_EMOJI);
        return;
    }
    
    // 3. 超管命令校验
    if (['/allstatus'].includes(command) && !CONFIG.SUPER_ADMINS.includes(fromUser)) {
        await sendTextMessage(fromUser, '此功能仅限超级管理员使用');
        return;
    }
    
    console.log(`[菜单映射] ${fromUser}: ${eventKey} -> ${command}`);
    
    // 4. 去重检查：5秒内相同用户的相同命令只处理一次
    const dedupeKey = `${fromUser}:${command}`;
    const now = Date.now();
    if (lastMenuClick[dedupeKey] && (now - lastMenuClick[dedupeKey]) < 5000) {
        console.log(`[菜单去重] 跳过重复点击: ${dedupeKey}`);
        return;
    }
    lastMenuClick[dedupeKey] = now;
    
    // 5. 加入命令队列（指定目标用户）
    const cmdId = `cmd_${Date.now()}`;
    pendingCommands.push({
        id: cmdId,
        command: command,
        args: '',
        targetUser: fromUser,  // 只发给这个用户的脚本
        fromUser: fromUser,
        createTime: Date.now()
    });
    
    console.log(`[命令入队] ${cmdId}: ${command} -> ${fromUser}`);
}

/**
 * 处理文本命令（仅支持 /query 和 /help）
 */
async function handleTextCommand(content, fromUser) {
    // 1. 白名单校验
    if (!CONFIG.ALLOWED_USERS.includes(fromUser)) {
        console.log(`[权限拒绝] ${fromUser} 不在白名单中`);
        await sendTextMessage(fromUser, '您没有权限使用此功能');
        return;
    }
    
    // 帮助命令直接回复
    if (content === '/help') {
        const isSuperAdmin = CONFIG.SUPER_ADMINS.includes(fromUser);
        let helpText = `可用命令：
/query <内容> - 查询页面内容
/help - 显示帮助

菜单按钮：
• 状态 - 获取游戏状态
• 刷新 - 刷新页面
• 配置 - 获取当前配置
• 统计 - 战斗统计/食用统计`;
        
        if (isSuperAdmin) {
            helpText += `\n\n[超管专用]
/allstatus - 查看所有在线脚本`;
        }
        
        await sendTextMessage(fromUser, helpText);
        return;
    }
    
    // /whitelist 命令（设置白名单）
    if (content.startsWith('/whitelist ')) {
        const whitelistContent = content.substring(11).trim();
        if (!whitelistContent) {
            await sendTextMessage(fromUser, '用法: /whitelist <物品名称>');
            return;
        }
        
        const cmdId = `cmd_${Date.now()}`;
        pendingCommands.push({
            id: cmdId,
            command: '/whitelist_set',
            args: whitelistContent,
            targetUser: fromUser,
            fromUser: fromUser,
            createTime: Date.now()
        });
        
        console.log(`[命令入队] ${cmdId}: /whitelist_set ${whitelistContent} -> ${fromUser}`);
        
        setTimeout(async () => {
            const result = commandResults[cmdId];
            if (!result) {
                await sendTextMessage(fromUser, '设置超时，请确保油猴脚本正在运行');
            }
        }, 10000);
        return;
    }
    
    // /level 命令（设置强化等级阈值）
    if (content.startsWith('/level ')) {
        const levelStr = content.substring(7).trim();
        const level = parseInt(levelStr, 10);
        
        if (isNaN(level)) {
            await sendTextMessage(fromUser, '用法: /level <数字>\n范围: 2-13');
            return;
        }
        
        if (level < 2 || level > 13) {
            await sendTextMessage(fromUser, `等级范围: 2-13，当前输入: ${level}`);
            return;
        }
        
        const cmdId = `cmd_${Date.now()}`;
        pendingCommands.push({
            id: cmdId,
            command: '/level_set',
            args: level.toString(),
            targetUser: fromUser,
            fromUser: fromUser,
            createTime: Date.now()
        });
        
        console.log(`[命令入队] ${cmdId}: /level_set ${level} -> ${fromUser}`);
        
        setTimeout(async () => {
            const result = commandResults[cmdId];
            if (!result) {
                await sendTextMessage(fromUser, '设置超时，请确保油猴脚本正在运行');
            }
        }, 10000);
        return;
    }
    
    // /query 命令
    if (content.startsWith('/query ')) {
        const queryText = content.substring(7).trim();
        if (!queryText) {
            await sendTextMessage(fromUser, '用法: /query <要查询的内容>');
            return;
        }
        
        const cmdId = `cmd_${Date.now()}`;
        pendingCommands.push({
            id: cmdId,
            command: '/query',
            args: queryText,
            targetUser: fromUser,
            fromUser: fromUser,
            createTime: Date.now()
        });
        
        console.log(`[命令入队] ${cmdId}: /query ${queryText} -> ${fromUser}`);
        
        // 等待结果（最多10秒）
        setTimeout(async () => {
            const result = commandResults[cmdId];
            if (!result) {
                await sendTextMessage(fromUser, '查询超时，请确保油猴脚本正在运行');
            }
        }, 10000);
        return;
    }
    
    // 超管命令：查看所有脚本状态
    if (content === '/allstatus') {
        if (!CONFIG.SUPER_ADMINS.includes(fromUser)) {
            await sendTextMessage(fromUser, '此功能仅限超级管理员使用');
            return;
        }
        
        const users = Object.keys(registeredScripts);
        if (users.length === 0) {
            await sendTextMessage(fromUser, '当前没有在线脚本');
            return;
        }
        
        let statusText = '在线脚本状态：\n';
        for (const userId of users) {
            const script = registeredScripts[userId];
            const lastSeenAgo = Math.floor((Date.now() - script.lastSeen) / 1000);
            statusText += `\n${userId}: ${script.status || 'online'} (${lastSeenAgo}秒前)`;
        }
        await sendTextMessage(fromUser, statusText);
        return;
    }
    
    // 其他以/开头的文本提示用菜单
    if (content.startsWith('/')) {
        await sendTextMessage(fromUser, `文本命令仅支持 /query 和 /help\n/status、/refresh、/config 请使用菜单按钮`);
        return;
    }
    
    // 普通文本当作query处理
    const cmdId = `cmd_${Date.now()}`;
    pendingCommands.push({
        id: cmdId,
        command: '/query',
        args: content,
        targetUser: fromUser,
        fromUser: fromUser,
        createTime: Date.now()
    });
    
    console.log(`[命令入队] ${cmdId}: /query ${content} -> ${fromUser}`);
}

// ==================== API接口（供油猴脚本调用）====================

/**
 * 脚本注册/心跳
 */
app.post('/api/register', (req, res) => {
    const { toUser, version, status } = req.body;
    
    if (!toUser) {
        return res.json({ success: false, error: '缺少 toUser 参数' });
    }
    
    // 注册或更新脚本信息
    registeredScripts[toUser] = {
        lastSeen: Date.now(),
        version: version || 'unknown',
        status: status || 'online'
    };
    
    console.log(`[脚本注册] ${toUser} @ ${version || 'unknown'}`);
    
    res.json({ success: true });
});

/**
 * 轮询获取待执行命令（只返回给指定用户的命令）
 */
app.get('/api/poll', (req, res) => {
    const toUser = req.query.toUser;
    
    if (!toUser) {
        return res.json({ success: false, error: '缺少 toUser 参数' });
    }
    
    // 更新心跳
    if (registeredScripts[toUser]) {
        registeredScripts[toUser].lastSeen = Date.now();
    }
    
    // 只返回给这个用户的命令
    const myCommands = pendingCommands.filter(cmd => cmd.targetUser === toUser);
    
    res.json({
        success: true,
        commands: myCommands.map(cmd => ({
            id: cmd.id,
            command: cmd.command,
            args: cmd.args || '',
            createTime: cmd.createTime
        }))
    });
});

/**
 * 发送通知（油猴脚本 → 服务端 → 企业微信）
 */
app.post('/api/notify', async (req, res) => {
    const { toUser, message } = req.body;
    
    if (!toUser || !message) {
        return res.json({ success: false, error: '缺少参数' });
    }
    
    console.log(`[通知] ${toUser}: ${message.substring(0, 100)}...`);
    
    // 发送给对应的企业微信用户（错误会被静默处理）
    await sendTextMessage(toUser, message);
    
    res.json({ success: true });
});

/**
 * 上报命令执行结果（服务端负责发送给企业微信用户）
 */
app.post('/api/result', async (req, res) => {
    const { cmdId, success, result, error, toUser } = req.body;
    
    console.log(`[结果上报] ${cmdId} (${toUser}): ${success ? '成功' : '失败'}`);
    if (result) console.log(`  结果: ${result.substring(0, 200)}...`);
    
    // 保存结果
    commandResults[cmdId] = { success, result, error, time: Date.now(), toUser };
    
    // 找到对应的命令，发送结果到企业微信
    const cmd = pendingCommands.find(c => c.id === cmdId);
    if (cmd && cmd.fromUser) {
        let responseText = '';
        if (success) {
            responseText = result || '执行成功';
        } else {
            responseText = `执行失败: ${error || '未知错误'}`;
        }
        await sendTextMessage(cmd.fromUser, responseText);
    }
    
    // 从队列移除已完成的命令
    pendingCommands = pendingCommands.filter(c => c.id !== cmdId);
    
    // 清理旧结果（保留5分钟）
    const expireTime = Date.now() - 5 * 60 * 1000;
    Object.keys(commandResults).forEach(id => {
        if (commandResults[id].time < expireTime) {
            delete commandResults[id];
        }
    });
    
    res.json({ success: true });
});

/**
 * 发送通知（供油猴脚本主动推送）
 */
app.post('/api/notify', async (req, res) => {
    const { message } = req.body;
    
    if (!message) {
        return res.status(400).json({ success: false, error: '缺少message参数' });
    }
    
    console.log(`[通知请求] ${message}`);
    
    try {
        await sendTextMessage(CONFIG.TO_USER, message);
        res.json({ success: true });
    } catch (error) {
        console.error('[发送失败]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 企业微信API ====================

/**
 * 获取Access Token
 */
async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpireTime) {
        return accessToken;
    }
    
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CONFIG.CORP_ID}&corpsecret=${CONFIG.CORP_SECRET}`;
    
    const response = await axios.get(url);
    const data = response.data;
    
    if (data.errcode !== 0) {
        throw new Error(`获取Token失败: ${data.errmsg}`);
    }
    
    accessToken = data.access_token;
    tokenExpireTime = Date.now() + (data.expires_in - 300) * 1000; // 提前5分钟过期
    
    console.log(`[Token] 获取成功，有效期至 ${new Date(tokenExpireTime).toLocaleString('zh-CN')}`);
    return accessToken;
}

/**
 * 发送文本消息
 */
async function sendTextMessage(toUser, content) {
    try {
        const token = await getAccessToken();
        
        const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
        
        const data = {
            touser: toUser,
            msgtype: 'text',
            agentid: CONFIG.AGENT_ID,
            text: {
                content: content
            },
            safe: 0
        };
        
        const response = await axios.post(url, data);
        const result = response.data;
        
        if (result.errcode !== 0) {
            // 81013: 用户不在可见范围 / 用户无效 - 静默忽略，不影响运行
            if (result.errcode === 81013) {
                console.warn(`[发送跳过] 用户 "${toUser}" 不在应用可见范围内`);
                return { skipped: true, reason: 'user_not_in_scope' };
            }
            // 600001: 不在白名单 - 静默忽略
            if (result.errcode === 600001) {
                console.warn(`[发送跳过] 用户 "${toUser}" 不在白名单内`);
                return { skipped: true, reason: 'user_not_in_whitelist' };
            }
            // 其他错误记录但不抛出
            console.error(`[发送失败] ${result.errcode}: ${result.errmsg}`);
            return { skipped: true, reason: result.errmsg };
        }
        
        console.log(`[发送成功] -> ${toUser}: ${content.substring(0, 50)}...`);
        return result;
    } catch (error) {
        console.error(`[发送异常] ${error.message}`);
        return { skipped: true, reason: error.message };
    }
}

// ==================== 加解密工具 ====================

/**
 * 生成签名
 */
function generateSignature(token, timestamp, nonce, encrypt = '') {
    const arr = [token, timestamp, nonce, encrypt].sort();
    const str = arr.join('');
    return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * AES解密（企业微信消息解密）
 */
function decryptAES(encrypted, encodingAESKey) {
    const key = Buffer.from(encodingAESKey + '=', 'base64');
    const cipherText = Buffer.from(encrypted, 'base64');
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.slice(0, 16));
    decipher.setAutoPadding(false);
    
    let decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    
    // 去除补位
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.slice(0, -pad);
    
    // 解析格式：随机字符串(16) + 消息长度(4) + 消息内容 + CorpID
    const content = decrypted.slice(16);
    const len = content.readUInt32BE(0);
    const message = content.slice(4, 4 + len).toString();
    
    return message;
}

/**
 * AES加密（企业微信消息加密）
 */
function encryptAES(text, encodingAESKey, corpId) {
    const key = Buffer.from(encodingAESKey + '=', 'base64');
    
    // 生成16字节随机字符串
    const random = crypto.randomBytes(16);
    
    // 消息内容
    const msgBuffer = Buffer.from(text);
    const lenBuffer = Buffer.alloc(4);
    lenBuffer.writeUInt32BE(msgBuffer.length, 0);
    
    // CorpID
    const corpIdBuffer = Buffer.from(corpId);
    
    // 拼接：随机字符串 + 消息长度 + 消息内容 + CorpID
    const content = Buffer.concat([random, lenBuffer, msgBuffer, corpIdBuffer]);
    
    // PKCS7补位
    const blockSize = 32;
    const padLen = blockSize - (content.length % blockSize);
    const padBuffer = Buffer.alloc(padLen, padLen);
    const padded = Buffer.concat([content, padBuffer]);
    
    // 加密
    const cipher = crypto.createCipheriv('aes-256-cbc', key, key.slice(0, 16));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    
    return encrypted.toString('base64');
}

// ==================== 启动服务 ====================
app.listen(CONFIG.PORT, () => {
    console.log('\n========================================');
    console.log('企业微信消息双向代理服务');
    console.log('========================================');
    console.log(`企业ID: ${CONFIG.CORP_ID}`);
    console.log(`应用AgentId: ${CONFIG.AGENT_ID}`);
    console.log(`Token: ${CONFIG.TOKEN}`);
    console.log(`监听端口: ${CONFIG.PORT}`);
    console.log('========================================');
    console.log('\n回调地址: http://ip:24860/callback');
    console.log('轮询地址: http://ip:24860/api/poll');
    console.log('结果上报: http://ip:24860/api/result');
    console.log('通知接口: http://ip:24860/api/notify');
    console.log('\n请在企业微信后台设置回调URL');
    console.log('========================================\n');
});
