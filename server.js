const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const axios = require('axios');
const path = require('path');

const GOOGLE_SHEET_ID = '1rbqlvNFfiGKwNSsSKuekgTs-j5qLevctBvyv7fPqIh8';
const GM_CREATE_PASS = process.env.GM_PASS || 'gm1234'; // 서버 환경변수 GM_PASS로 변경 가능

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// rooms: 방 데이터 (재입장을 위해 유지)
let rooms = {};
// users: 소켓ID → { roomTitle, name, isSpectator }
let users = {};

// ── 구글 시트 캐싱 ──
let cachedCommands = [];
let lastFetched = 0;
async function getCommandListFromSheet() {
    const now = Date.now();
    if (now - lastFetched < 60000 && cachedCommands.length > 0) return cachedCommands;
    try {
        const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:json`;
        const res = await axios.get(url, { timeout: 3000 });
        const json = res.data.substring(res.data.indexOf('{'), res.data.lastIndexOf('}') + 1);
        const data = JSON.parse(json);
        cachedCommands = data.table.rows.map(r => ({ cmd: r.c[0]?.v || '', text: r.c[1]?.v || '' })).filter(r => r.cmd);
        lastFetched = now;
    } catch (e) {}
    return cachedCommands;
}

function broadcastRoomData(roomTitle) {
    const room = rooms[roomTitle];
    if (!room) return;
    io.to(roomTitle).emit('update_data', {
        characters: room.characters,
        items: room.items,
        mapInfo: room.mapInfo,
        creatorName: room.creatorName,
        spectatorCount: room.spectators ? room.spectators.length : 0
    });
}

io.on('connection', (socket) => {

    socket.on('get_room_list', () => {
        socket.emit('room_list', Object.keys(rooms).map(title => ({
            title,
            hasPassword: rooms[title].password !== '',
            playerCount: Object.keys(rooms[title].characters).length
        })));
    });

    socket.on('create_room', ({ title, password, creatorName, createPass }) => {
        if (!title?.trim()) return socket.emit('system_alert', '방 제목을 입력하세요.');
        if (!creatorName?.trim()) return socket.emit('system_alert', '닉네임을 입력하세요.');
        if (createPass !== GM_CREATE_PASS) return socket.emit('system_alert', '❌ GM 비밀번호가 틀렸습니다.');
        if (rooms[title]) return socket.emit('system_alert', '이미 존재하는 방입니다.');
        rooms[title] = {
            password: password || '',
            creatorName,
            characters: {},
            items: [],
            mapInfo: '로비',
            spectators: [],
            visitedLocations: ['로비'], // 조사 기록용
            sessionItems: []            // 조사 중 아이템 기록
        };
        socket.emit('create_success', title);
    });

    // ── 재입장 (새로고침/재접속) ──
    socket.on('rejoin_room', async ({ title, name, isSpectator, avatar, bio }) => {
        const room = rooms[title];
        if (!room) return socket.emit('system_alert', '방이 사라졌습니다. 다시 입장해주세요.');

        // 기존 소켓 정리
        const oldId = Object.keys(users).find(id => users[id].roomTitle === title && users[id].name === name);
        if (oldId && oldId !== socket.id) delete users[oldId];

        socket.join(title);
        users[socket.id] = { roomTitle: title, name, isSpectator: isSpectator || false };

        if (isSpectator) {
            if (!room.spectators.includes(name)) room.spectators.push(name);
        } else {
            // 캐릭터 데이터 복원 또는 신규 생성
            if (!room.characters[name]) room.characters[name] = { hp: 10, san: 10, avatar: avatar || '', bio: bio || '' };
            else {
                if (avatar) room.characters[name].avatar = avatar;
                if (bio !== undefined) room.characters[name].bio = bio;
            }
        }

        const isAdmin = room.creatorName === name;
        const cmds = await getCommandListFromSheet();
        socket.emit('join_success', { title, isAdmin, isSpectator: isSpectator || false });
        socket.emit('update_commands', cmds);

        // 기존 채팅 히스토리 전송
        if (room.chatHistory) {
            room.chatHistory.forEach(msg => socket.emit('msg_receive', msg));
        }

        broadcastRoomData(title);
    });

    // ── 일반 입장 ──
    socket.on('join_room', async ({ title, password, name, hp, san, avatar, bio }) => {
        const room = rooms[title];
        if (!room) return socket.emit('system_alert', '방이 없습니다.');
        if (!name?.trim()) return socket.emit('system_alert', '닉네임을 입력하세요.');

        const isSpectator = room.password !== '' && password === '';
        if (!isSpectator && room.password !== '' && room.password !== password)
            return socket.emit('system_alert', '비밀번호가 틀렸습니다.');

        const oldId = Object.keys(users).find(id => users[id].roomTitle === title && users[id].name === name);
        if (oldId && oldId !== socket.id) return socket.emit('system_alert', '이미 사용 중인 닉네임입니다.');

        socket.join(title);
        users[socket.id] = { roomTitle: title, name, isSpectator };

        if (isSpectator) {
            room.spectators.push(name);
            socket.emit('join_success', { title, isAdmin: false, isSpectator: true });
            const sysMsg = { sender: '시스템', text: `👁 ${name} 님이 관전을 시작합니다.`, type: 'system' };
            io.to(title).emit('msg_receive', sysMsg);
            room.chatHistory = room.chatHistory || [];
            room.chatHistory.push(sysMsg);
            broadcastRoomData(title);
            return;
        }

        const hpVal = Math.min(100, Math.max(0, parseInt(hp) || 0));
        const sanVal = Math.min(100, Math.max(0, parseInt(san) || 0));
        

        room.characters[name] = { hp: hpVal, san: sanVal, avatar: avatar || '', bio: bio || '' };

        const isAdmin = room.creatorName === name;
        const cmds = await getCommandListFromSheet();
        socket.emit('join_success', { title, isAdmin, isSpectator: false });
        socket.emit('update_commands', cmds);

        // 기존 채팅 히스토리 전송
        if (room.chatHistory) {
            room.chatHistory.forEach(msg => socket.emit('msg_receive', msg));
        }

        const sysMsg = { sender: '시스템', text: `${name} 입장`, type: 'system' };
        io.to(title).emit('msg_receive', sysMsg);
        room.chatHistory = room.chatHistory || [];
        room.chatHistory.push(sysMsg);

        broadcastRoomData(title);
    });

    // ── 프로필 업데이트 ──
    socket.on('update_profile', ({ avatar, bio }) => {
        const user = users[socket.id];
        if (!user || user.isSpectator) return;
        const room = rooms[user.roomTitle];
        if (!room || !room.characters[user.name]) return;
        if (avatar !== undefined) room.characters[user.name].avatar = avatar;
        if (bio !== undefined) room.characters[user.name].bio = bio;
        broadcastRoomData(user.roomTitle);
    });

    // ── GM 이미지 공유 ──
    socket.on('share_image', ({ imageUrl }) => {
        const user = users[socket.id];
        if (!user) return;
        const room = rooms[user.roomTitle];
        if (!room || room.creatorName !== user.name) return;
        const msg = { sender: '시스템', text: `📷 GM이 이미지를 공유했습니다.|${imageUrl}`, type: 'system' };
        io.to(user.roomTitle).emit('msg_receive', msg);
        room.chatHistory = room.chatHistory || [];
        room.chatHistory.push(msg);
    });

    // ── 메시지 전송 ──
    socket.on('msg_send', async (text) => {
        const user = users[socket.id];
        if (!user) return;
        const room = rooms[user.roomTitle];
        if (!room) return;
        if (user.isSpectator) return socket.emit('system_alert', '관전자는 채팅을 보낼 수 없습니다.');

        const isAdmin = room.creatorName === user.name;
        room.chatHistory = room.chatHistory || [];

        if (text.startsWith('/')) {
            if (!isAdmin) return socket.emit('system_alert', '❌ 방장 전용 명령어입니다.');
            const parts = text.slice(1).split(' ');
            const cmd = parts[0];

            // 강퇴
            if (cmd === '강퇴') {
                const targetName = parts[1];
                const targetId = Object.keys(users).find(id => users[id].roomTitle === user.roomTitle && users[id].name === targetName);
                if (!targetId) return socket.emit('system_alert', '해당 유저를 찾을 수 없습니다.');
                const msg = { sender: '시스템', text: `${targetName} 님이 강퇴되었습니다.`, type: 'system' };
                io.to(user.roomTitle).emit('msg_receive', msg);
                room.chatHistory.push(msg);
                io.to(targetId).emit('kick_user');
                const ts = io.sockets.sockets.get(targetId);
                if (ts) ts.disconnect(true);
            }

            // 아이템 획득
            else if (cmd === '아이템') {
                const itemName = parts.slice(1).filter(p => p !== '획득').join(' ');
                if (!itemName) return socket.emit('system_alert', '아이템 이름을 입력하세요.');
                const item = { name: itemName };
                room.items.push(item);
                room.sessionItems = room.sessionItems || [];
                room.sessionItems.push(item);
                const msg = { sender: '시스템', text: `[아이템] ${itemName} 획득`, type: 'system' };
                io.to(user.roomTitle).emit('msg_receive', msg);
                room.chatHistory.push(msg);
                broadcastRoomData(user.roomTitle);
            }

            // 층 이동
            else if (/^[A-Za-z0-9가-힣]+층$/.test(cmd)) {
                room.mapInfo = cmd;
                room.visitedLocations = room.visitedLocations || [];
                if (!room.visitedLocations.includes(cmd)) room.visitedLocations.push(cmd);
                const msg = { sender: '시스템', text: `[이동] 현재 위치: ${cmd}`, type: 'system' };
                io.to(user.roomTitle).emit('msg_receive', msg);
                room.chatHistory.push(msg);
                broadcastRoomData(user.roomTitle);
            }

            // 조사 종료 → 결과 팝업
            else if (cmd === '조사' && parts[1] === '종료') {
                const participants = Object.entries(room.characters).filter(([n]) => n !== room.creatorName);
                const summary = participants.map(([n, d]) => `${n}: 체력${d.hp}/정신력${d.san}`).join(' | ');
                const msg = { sender: '시스템', text: summary ? `[조사 종료] ${summary}` : '[조사 종료] 참여자 없음', type: 'system' };
                io.to(user.roomTitle).emit('msg_receive', msg);
                room.chatHistory.push(msg);

                // 결과 팝업 데이터 전송
                io.to(user.roomTitle).emit('survey_result', {
                    locations: room.visitedLocations || [],
                    items: room.sessionItems || [],
                    characters: room.characters,
                    creatorName: room.creatorName
                });

                // 세션 기록 초기화
                room.visitedLocations = [room.mapInfo];
                room.sessionItems = [];
            }

            // 캐릭터 스탯 조작
            else if (room.characters[cmd]) {
                const target = cmd;
                if (parts[1] === '체력' || parts[1] === '정신력') {
                    const amount = parseInt(parts[2]) || 0;
                    const stat = parts[1] === '체력' ? 'hp' : 'san';
                    room.characters[target][stat] = Math.max(0, Math.min(100, room.characters[target][stat] + amount));
                    const msg = { sender: '시스템', text: `[스탯] ${target}의 ${parts[1]}: ${room.characters[target][stat]}`, type: 'system' };
                    io.to(user.roomTitle).emit('msg_receive', msg);
                    room.chatHistory.push(msg);
                    broadcastRoomData(user.roomTitle);
                } else if (parts[1] === '룰렛') {
                    const roll = Math.floor(Math.random() * 100) + 1;
                    const san = room.characters[target].san;
                    const result = roll <= Math.floor(san / 5) ? '💥 대성공' : roll <= san ? '✅ 성공' : roll >= 96 ? '💀 대실패' : '❌ 실패';
                    const msg = { sender: '시스템', text: `🎲 ${target} 룰렛: ${roll} / ${san} → ${result}`, type: 'system' };
                    io.to(user.roomTitle).emit('msg_receive', msg);
                    room.chatHistory.push(msg);
                }
            }

            // 구글 시트 명령어
            else {
                const cmds = await getCommandListFromSheet();
                const match = cmds.find(c => c.cmd === text);
                if (match) {
                    const msg = { sender: '연출', text: match.text, type: 'system' };
                    io.to(user.roomTitle).emit('msg_receive', msg);
                    room.chatHistory.push(msg);
                } else {
                    socket.emit('system_alert', '알 수 없는 명령어입니다.');
                }
            }
        } else {
            const msg = { sender: user.name, text, type: 'chat' };
            io.to(user.roomTitle).emit('msg_receive', msg);
            room.chatHistory.push(msg);
            // 히스토리 너무 길어지면 앞부분 자르기 (최대 200개)
            if (room.chatHistory.length > 200) room.chatHistory = room.chatHistory.slice(-200);
        }
    });

    // ── 연결 종료 ──
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (!user) return;
        const room = rooms[user.roomTitle];
        if (room) {
            if (user.isSpectator) {
                room.spectators = room.spectators.filter(n => n !== user.name);
                const msg = { sender: '시스템', text: `👁 ${user.name} 관전 종료`, type: 'system' };
                io.to(user.roomTitle).emit('msg_receive', msg);
                broadcastRoomData(user.roomTitle);
            } else {
                delete room.characters[user.name];
                if (room.creatorName === user.name) {
                    const msg = { sender: '시스템', text: '방장이 퇴장하여 방이 종료됩니다.', type: 'system' };
                    io.to(user.roomTitle).emit('msg_receive', msg);
                    setTimeout(() => {
                        io.to(user.roomTitle).emit('room_closed');
                        delete rooms[user.roomTitle];
                    }, 1000);
                } else {
                    const msg = { sender: '시스템', text: `${user.name} 퇴장`, type: 'system' };
                    io.to(user.roomTitle).emit('msg_receive', msg);
                    room.chatHistory = room.chatHistory || [];
                    room.chatHistory.push(msg);
                    broadcastRoomData(user.roomTitle);
                }
            }
        }
        delete users[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`✅ 서버 가동 중 http://localhost:${PORT}`));
