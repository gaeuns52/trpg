const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const axios = require('axios');
const path = require('path');

const GOOGLE_SHEET_ID = '1rbqlvNFfiGKwNSsSKuekgTs-j5qLevctBvyv7fPqIh8';

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let rooms = {};
let users = {};

let cachedCommands = [];
let lastFetched = 0;

async function getCommandListFromSheet() {
    const now = Date.now();
    if (now - lastFetched < 60000 && cachedCommands.length > 0) return cachedCommands;
    try {
        const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:json`;
        const response = await axios.get(url, { timeout: 3000 });
        const jsonString = response.data.substring(response.data.indexOf("{"), response.data.lastIndexOf("}") + 1);
        const data = JSON.parse(jsonString);
        cachedCommands = data.table.rows.map(row => ({ cmd: row.c[0]?.v || "", text: row.c[1]?.v || "" })).filter(r => r.cmd);
        lastFetched = now;
        return cachedCommands;
    } catch (e) {
        return cachedCommands;
    }
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
        const list = Object.keys(rooms).map(title => ({
            title,
            hasPassword: rooms[title].password !== "",
            playerCount: Object.keys(rooms[title].characters).length,
            spectatorCount: rooms[title].spectators ? rooms[title].spectators.length : 0
        }));
        socket.emit('room_list', list);
    });

    socket.on('create_room', ({ title, password, creatorName }) => {
        if (!title || !title.trim()) return socket.emit('system_alert', '방 제목을 입력해주세요.');
        if (rooms[title]) return socket.emit('system_alert', '이미 존재하는 방입니다.');
        rooms[title] = { password: password || "", creatorName, items: [], characters: {}, mapInfo: "로비", spectators: [] };
        socket.emit('create_success', title);
    });

    socket.on('rejoin_room', async ({ title, name, isSpectator }) => {
        const room = rooms[title];
        if (!room) return socket.emit('system_alert', '방이 사라졌습니다. 다시 입장해주세요.');

        const existingId = Object.keys(users).find(id => users[id].roomTitle === title && users[id].name === name);
        if (existingId && existingId !== socket.id) delete users[existingId];

        socket.join(title);
        users[socket.id] = { roomTitle: title, name, isSpectator: isSpectator || false };

        if (isSpectator) {
            if (!room.spectators) room.spectators = [];
            if (!room.spectators.includes(name)) room.spectators.push(name);
        } else {
            if (!room.characters[name]) room.characters[name] = { hp: 10, san: 10 };
        }

        const isAdmin = room.creatorName === name;
        const commands = await getCommandListFromSheet();
        socket.emit('join_success', { title, isAdmin, isSpectator: isSpectator || false });
        socket.emit('update_commands', commands);
        broadcastRoomData(title);
    });

    socket.on('join_room', async ({ title, password, name, hp, san }) => {
        const room = rooms[title];
        if (!room) return socket.emit('system_alert', '방이 없습니다.');
        if (!name || !name.trim()) return socket.emit('system_alert', '닉네임을 입력해주세요.');

        const isSpectator = (room.password !== "" && password === "");

        if (!isSpectator && room.password !== "" && room.password !== password) {
            return socket.emit('system_alert', '비밀번호가 틀렸습니다.');
        }

        const existingId = Object.keys(users).find(id => users[id].roomTitle === title && users[id].name === name);
        if (existingId && existingId !== socket.id) return socket.emit('system_alert', '이미 사용 중인 닉네임입니다.');

        if (isSpectator) {
            if (!room.spectators) room.spectators = [];
            socket.join(title);
            users[socket.id] = { roomTitle: title, name, isSpectator: true };
            room.spectators.push(name);
            socket.emit('join_success', { title, isAdmin: false, isSpectator: true });
            io.to(title).emit('msg_receive', { sender: '시스템', text: `👁 ${name} 님이 관전을 시작합니다.`, type: 'system' });
            broadcastRoomData(title);
            return;
        }

        const hpValue = parseInt(hp) || 0;
        const sanValue = parseInt(san) || 0;
        if (hpValue < 0 || hpValue > 100 || sanValue < 0 || sanValue > 100 || hpValue + sanValue > 120) {
            return socket.emit('system_alert', '체력과 정신력은 각각 0~100, 총합은 120 이하여야 합니다.');
        }

        socket.join(title);
        users[socket.id] = { roomTitle: title, name, isSpectator: false };
        room.characters[name] = { hp: hpValue, san: sanValue };

        const isAdmin = room.creatorName === name;
        const commands = await getCommandListFromSheet();
        socket.emit('join_success', { title, isAdmin, isSpectator: false });
        socket.emit('update_commands', commands);
        io.to(title).emit('msg_receive', { sender: '시스템', text: `${name} 입장`, type: 'system' });
        broadcastRoomData(title);
    });

    socket.on('msg_send', async (text) => {
        const user = users[socket.id];
        if (!user) return;
        const room = rooms[user.roomTitle];
        if (!room) return;

        if (user.isSpectator) return socket.emit('system_alert', '관전자는 채팅을 보낼 수 없습니다.');

        const isAdmin = room.creatorName === user.name;

        if (text.startsWith('/')) {
            if (!isAdmin) return socket.emit('system_alert', '❌ 방장 전용 명령어입니다.');
            const parts = text.slice(1).split(' ');
            const cmd = parts[0];

            if (cmd === '강퇴') {
                const targetName = parts[1];
                const targetId = Object.keys(users).find(id => users[id].roomTitle === user.roomTitle && users[id].name === targetName);
                if (!targetId) return socket.emit('system_alert', '해당 유저를 찾을 수 없습니다.');
                io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: `${targetName} 님이 강퇴되었습니다.`, type: 'system' });
                io.to(targetId).emit('kick_user');
                const ts = io.sockets.sockets.get(targetId);
                if (ts) ts.disconnect(true);
            }
            else if (cmd === '아이템') {
                const itemName = parts.slice(1).filter(p => p !== '획득').join(' ');
                if (!itemName) return socket.emit('system_alert', '아이템 이름을 입력해주세요.');
                room.items.push({ name: itemName, count: 1 });
                io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: `[아이템] ${itemName} 획득`, type: 'system' });
                broadcastRoomData(user.roomTitle);
            }
            else if (/^[A-Za-z0-9가-힣]+층$/.test(cmd)) {
                room.mapInfo = cmd;
                io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: `[이동] 현재 위치: ${cmd}`, type: 'system' });
                broadcastRoomData(user.roomTitle);
            }
            else if (cmd === '조사' && parts[1] === '종료') {
                const participants = Object.entries(room.characters).filter(([n]) => n !== room.creatorName);
                const summary = participants.map(([n, d]) => `${n}: 체력${d.hp}/정신력${d.san}`).join(' | ');
                io.to(user.roomTitle).emit('msg_receive', {
                    sender: '시스템',
                    text: summary === '' ? '[조사 종료] 참여자 없음' : `[조사 종료] ${summary}`,
                    type: 'system'
                });
            }
            else if (room.characters[cmd]) {
                const target = cmd;
                if (parts[1] === '체력' || parts[1] === '정신력') {
                    const amount = parseInt(parts[2]) || 0;
                    const stat = parts[1] === '체력' ? 'hp' : 'san';
                    room.characters[target][stat] = Math.max(0, Math.min(100, room.characters[target][stat] + amount));
                    io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: `[스탯] ${target}의 ${parts[1]}: ${room.characters[target][stat]}`, type: 'system' });
                    broadcastRoomData(user.roomTitle);
                } else if (parts[1] === '룰렛') {
                    const roll = Math.floor(Math.random() * 100);
                    const success = roll < room.characters[target].san;
                    io.to(user.roomTitle).emit('msg_receive', {
                        sender: '시스템',
                        text: `${target} 룰렛: ${success ? '✅ 성공' : '❌ 실패'} (${roll} / 기준 ${room.characters[target].san})`,
                        type: 'system'
                    });
                }
            }
            else {
                const commands = await getCommandListFromSheet();
                const sheetMatch = commands.find(c => c.cmd === text);
                if (sheetMatch) {
                    io.to(user.roomTitle).emit('msg_receive', { sender: '연출', text: sheetMatch.text, type: 'system' });
                } else {
                    socket.emit('system_alert', '알 수 없는 명령어입니다.');
                }
            }
        } else {
            io.to(user.roomTitle).emit('msg_receive', { sender: user.name, text, type: 'chat' });
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (!user) return;
        const room = rooms[user.roomTitle];
        if (room) {
            if (user.isSpectator) {
                if (room.spectators) room.spectators = room.spectators.filter(n => n !== user.name);
                io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: `👁 ${user.name} 관전 종료`, type: 'system' });
                broadcastRoomData(user.roomTitle);
            } else {
                delete room.characters[user.name];
                if (room.creatorName === user.name) {
                    io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: '방장이 퇴장하여 방이 종료됩니다.', type: 'system' });
                    setTimeout(() => { io.to(user.roomTitle).emit('room_closed'); delete rooms[user.roomTitle]; }, 1000);
                } else {
                    io.to(user.roomTitle).emit('msg_receive', { sender: '시스템', text: `${user.name} 퇴장`, type: 'system' });
                    broadcastRoomData(user.roomTitle);
                }
            }
        }
        delete users[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`✅ 서버 가동 중 (http://localhost:${PORT})`));
