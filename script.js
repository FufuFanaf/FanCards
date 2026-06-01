// =================== CONSTANTS ===================
const COLORS = ['red','blue','green','yellow'];
const NUMBERS = ['0','1','2','3','4','5','6','7','8','9'];
const SPECIALS = ['skip','reverse','draw2'];
const WILD_TYPES = ['wild','wild4'];

// =================== STATE ===================
let peer = null;
let connections = [];
let isHost = false;
let myId = '';
let myName = '';
let roomCode = '';
let players = []; // [{id, name, cards:[]}]
let myIndex = 0;
let gameState = null;
let pendingColorCard = null;
let unoCallPending = false;
let unoTimer = null;
let selectedCard = null;
let wins = JSON.parse(localStorage.getItem('uno_wins') || '{}');
let restartVotes = {};
let totalPlayers = 0;

// =================== DECK ===================
function buildDeck() {
  const deck = [];
  let id = 0;
  for (const color of COLORS) {
    deck.push({id:id++, color, value:'0', type:'number'});
    for (let n = 1; n <= 9; n++) {
      for (let k = 0; k < 2; k++) deck.push({id:id++, color, value:String(n), type:'number'});
    }
    for (const sp of SPECIALS) {
      for (let k = 0; k < 2; k++) deck.push({id:id++, color, value:sp, type:'special'});
    }
  }
  for (let k = 0; k < 4; k++) deck.push({id:id++, color:'wild', value:'wild', type:'wild'});
  for (let k = 0; k < 4; k++) deck.push({id:id++, color:'wild', value:'wild4', type:'wild'});
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// =================== PEERJS ===================
function initPeer(id) {
  return new Promise((res, rej) => {
    const p = new Peer(id, {
      host: '0.peerjs.com', port: 443, path: '/',
      secure: true, debug: 0,
      config: { iceServers: [
        {urls:'stun:stun.l.google.com:19302'},
        {urls:'stun:stun1.l.google.com:19302'}
      ]}
    });
    p.on('open', (pid) => { myId = pid; res(p); });
    p.on('error', rej);
  });
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

async function createRoom() {
  myName = document.getElementById('playerName').value.trim() || 'CYBER_P1';
  setStatus('Menghubungkan<span class="loading-dots"></span>');
  try {
    roomCode = genCode();
    const hostPeerId = 'UNO_HOST_' + roomCode;
    peer = await initPeer(hostPeerId);
    isHost = true;
    document.getElementById('roomDisplay').classList.add('show');
    document.getElementById('roomCodeVal').textContent = roomCode;
    players = [{id: myId, name: myName, cards:[]}];
    setStatus('');
    updateWaitingList();
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        connections.push(conn);
        setupConn(conn);
      });
    });
  } catch(e) {
    setStatus('Error: ' + e.message);
  }
}

async function joinRoom() {
  myName = document.getElementById('playerName').value.trim() || 'CYBER_P' + Math.floor(Math.random()*99);
  const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
  if (!code || code.length !== 4) { setStatus('Kode room harus 4 karakter'); return; }
  roomCode = code;
  setStatus('Joining room<span class="loading-dots"></span>');
  try {
    const myPeerId = 'UNO_' + code + '_' + Date.now();
    peer = await initPeer(myPeerId);
    isHost = false;
    const hostId = 'UNO_HOST_' + code;
    const conn = peer.connect(hostId, {reliable:true});
    conn.on('open', () => {
      connections.push(conn);
      setupConn(conn);
      sendTo(conn, {type:'join', name:myName, id:myId});
      setStatus('Menunggu host memulai<span class="loading-dots"></span>');
    });
    conn.on('error', () => setStatus('Tidak bisa connect ke room'));
  } catch(e) {
    setStatus('Error: ' + e.message);
  }
}

function setupConn(conn) {
  conn.on('data', (data) => handleMsg(data, conn));
  conn.on('close', () => {
    connections = connections.filter(c => c !== conn);
    showNotif('Seorang pemain disconnect', 'warn');
  });
}

function sendTo(conn, msg) {
  try { conn.send(msg); } catch(e) {}
}

function broadcast(msg, exceptConn) {
  for (const c of connections) {
    if (c !== exceptConn) sendTo(c, msg);
  }
}

function sendToAll(msg) {
  for (const c of connections) sendTo(c, msg);
}

function handleMsg(data, fromConn) {
  switch(data.type) {
    case 'join':
      if (isHost) {
        players.push({id:data.id, name:data.name, cards:[]});
        updateWaitingList();
        // Tell everyone
        sendToAll({type:'playerList', players: players.map(p=>({id:p.id,name:p.name}))});
        sendTo(fromConn, {type:'welcome', yourId:data.id, players:players.map(p=>({id:p.id,name:p.name}))});
      }
      break;
    case 'welcome':
      myId = data.yourId;
      players = data.players.map(p=>({...p,cards:[]}));
      myIndex = players.findIndex(p=>p.id===myId);
      updateWaitingList();
      break;
    case 'playerList':
      players = data.players.map(p=>({...p,cards:[]}));
      myIndex = players.findIndex(p=>p.id===myId);
      updateWaitingList();
      break;
    case 'gameStart':
      if (!isHost) {
        gameState = data.state;
        myIndex = players.findIndex(p=>p.id===myId);
        startGameUI();
      }
      break;
    case 'gameAction':
      if (isHost) {
        applyAction(data.action, data.playerId);
        broadcastState();
      }
      break;
    case 'stateSync':
      if (!isHost) {
        gameState = data.state;
        renderGame();
      }
      break;
    case 'restart':
      if (isHost) {
        restartVotes[data.playerId] = true;
        const allVoted = players.every(p => restartVotes[p.id]);
        if (allVoted || Object.keys(restartVotes).length >= players.length) {
          restartVotes = {};
          hostStartGame();
        } else {
          document.getElementById('victoryStatus').textContent = Object.keys(restartVotes).length + '/' + players.length + ' setuju restart';
        }
      } else {
        restartVotes[data.playerId] = true;
        document.getElementById('victoryStatus').textContent = Object.keys(restartVotes).length + '/' + players.length + ' setuju restart';
      }
      broadcast({type:'restart', playerId:data.playerId}, fromConn);
      break;
    case 'unoClaim':
      handleUnoClaim(data.claimerId, data.targetId);
      break;
    case 'notification':
      showNotif(data.msg, data.kind);
      break;
  }
}

function updateWaitingList() {
  const el = document.getElementById('waitingPlayers');
  const startWrap = document.getElementById('startBtnWrap');
  el.style.display = 'flex';
  el.innerHTML = players.map(p=>`<div class="player-badge">✓ ${p.name}</div>`).join('');
  if (isHost && players.length >= 2) {
    startWrap.style.display = 'block';
  }
  if (isHost && players.length < 2) startWrap.style.display = 'none';
}

function startGameAsHost() {
  if (players.length < 2) { showNotif('Butuh minimal 2 pemain!', 'warn'); return; }
  hostStartGame();
}

function hostStartGame() {
  const deck = buildDeck();
  const dealt = [];
  for (let i = 0; i < players.length; i++) {
    dealt.push(deck.splice(0, 7));
  }
  // Find valid starting card (not wild)
  let topIdx = 0;
  while (deck[topIdx] && (deck[topIdx].type==='wild')) topIdx++;
  const topCard = deck.splice(topIdx, 1)[0];
  
  gameState = {
    deck,
    discardPile: [topCard],
    currentColor: topCard.color,
    currentTurn: 0,
    direction: 1,
    hands: dealt,
    stackPile: 0,
    stackType: null, // 'draw2' or 'wild4'
    finished: false,
    winner: null,
    unoUnprotected: {} // playerId: timestamp
  };

  players.forEach((p,i) => p.cards = [...dealt[i]]);
  myIndex = players.findIndex(p=>p.id===myId);

  // Send each player their hand + state (without others' full hands)
  for (let i = 0; i < connections.length; i++) {
    const playerIndex = players.findIndex(p => connections[i].peer.includes(p.id) || true);
    // Find which player this conn belongs to
    const pIdx = i + 1; // host is 0, connections are 1..n
    const maskedState = buildMaskedState(pIdx);
    sendTo(connections[i], {type:'gameStart', state:maskedState});
  }

  startGameUI();
}

function buildMaskedState(forPlayerIndex) {
  // Other players see only card counts, not actual cards
  return {
    ...gameState,
    hands: gameState.hands.map((hand, idx) => idx === forPlayerIndex ? hand : hand.map(c=>({...c, hidden:true}))),
    deck: gameState.deck.map(c=>({...c, hidden:true}))
  };
}

function broadcastState() {
  if (!isHost) return;
  for (let i = 0; i < connections.length; i++) {
    const pIdx = i + 1;
    const state = buildMaskedState(pIdx);
    sendTo(connections[i], {type:'stateSync', state});
  }
}

// =================== GAME LOGIC ===================
function applyAction(action, playerId) {
  if (!gameState || gameState.finished) return;
  const playerIdx = players.findIndex(p=>p.id===playerId);
  if (playerIdx < 0) return;

  switch(action.type) {
    case 'play':
      doPlayCard(playerIdx, action.cardId, action.chosenColor);
      break;
    case 'draw':
      doDrawCard(playerIdx);
      break;
    case 'uno':
      gameState.unoUnprotected[playerId] = null;
      broadcastNotif(players[playerIdx].name + ': UNO!', 'danger');
      break;
    case 'callUno':
      handleUnoClaim(playerId, action.targetId);
      break;
  }
}

function doPlayCard(playerIdx, cardId, chosenColor) {
  const hand = gameState.hands[playerIdx];
  const cardIdx = hand.findIndex(c => c.id === cardId);
  if (cardIdx < 0) return;
  const card = hand[cardIdx];

  if (!canPlay(card, gameState)) return;

  // Stack check: if stack active, must play stack card or draw
  if (gameState.stackPile > 0) {
    if (!isStackCard(card, gameState.stackType)) return;
  }

  // Remove from hand
  hand.splice(cardIdx, 1);
  gameState.discardPile.push(card);

  // Update color
  if (card.type === 'wild') {
    gameState.currentColor = chosenColor || 'red';
  } else {
    gameState.currentColor = card.color;
  }

  // Handle stacking
  if (card.value === 'draw2') {
    if (gameState.stackType === 'draw2' || gameState.stackType === null) {
      gameState.stackType = 'draw2';
      gameState.stackPile += 2;
    }
  } else if (card.value === 'wild4') {
    gameState.stackType = 'wild4';
    gameState.stackPile += 4;
  } else {
    // Non-stack card played, force draw if stack active
    if (gameState.stackPile > 0) {
      // Draw for current player (shouldn't happen, but safety)
    }
    gameState.stackPile = 0;
    gameState.stackType = null;
  }

  // Apply card effects
  let nextTurn = getNextPlayer(playerIdx);

  if (card.value === 'skip') {
    nextTurn = getNextPlayer(nextTurn);
    broadcastNotif('SKIP! Giliran ' + players[nextTurn > gameState.hands.length-1 ? 0 : nextTurn].name + ' di-skip', 'warn');
    // Recalculate to skip that player
    nextTurn = getNextPlayer(getNextPlayer(playerIdx));
  } else if (card.value === 'reverse') {
    gameState.direction *= -1;
    nextTurn = getNextPlayer(playerIdx);
    broadcastNotif('REVERSE! Arah dibalik', 'warn');
  } else if (card.value === 'draw2' && gameState.stackType === 'draw2' && gameState.stackPile === 2 && !wasStacking()) {
    // First draw2, stack started
  } else if ((card.value === 'draw2' || card.value === 'wild4') && gameState.stackPile > 0) {
    // Counter happened
    broadcastNotif('COUNTER! Stack jadi +' + gameState.stackPile, 'danger');
  }

  gameState.currentTurn = nextTurn;

  // Check force draw for next player if stack & no valid counter
  // (handled when next player acts)

  // UNO check
  if (hand.length === 1) {
    gameState.unoUnprotected[players[playerIdx].id] = Date.now();
    // Give 5 seconds to call UNO
  }

  // Win check
  if (hand.length === 0) {
    gameState.finished = true;
    gameState.winner = playerIdx;
    handleWin(playerIdx);
  }
}

let stackingInProgress = false;
function wasStacking() { return stackingInProgress; }

function doDrawCard(playerIdx) {
  const drawCount = gameState.stackPile > 0 ? gameState.stackPile : 1;
  for (let i = 0; i < drawCount; i++) {
    if (gameState.deck.length === 0) reshuffleDiscard();
    if (gameState.deck.length > 0) {
      gameState.hands[playerIdx].push(gameState.deck.pop());
    }
  }
  if (gameState.stackPile > 0) {
    broadcastNotif(players[playerIdx].name + ' mengambil ' + drawCount + ' kartu!', 'warn');
    gameState.stackPile = 0;
    gameState.stackType = null;
  }
  gameState.unoUnprotected[players[playerIdx].id] = null;
  gameState.currentTurn = getNextPlayer(playerIdx);
}

function reshuffleDiscard() {
  if (gameState.discardPile.length <= 1) return;
  const top = gameState.discardPile.pop();
  gameState.deck = shuffle(gameState.discardPile);
  gameState.discardPile = [top];
}

function getNextPlayer(fromIdx) {
  const n = gameState.hands.length;
  return ((fromIdx + gameState.direction) % n + n) % n;
}

function canPlay(card, state) {
  const top = state.discardPile[state.discardPile.length - 1];
  
  // If stack active, only stack cards valid (or must draw)
  if (state.stackPile > 0) {
    return isStackCard(card, state.stackType);
  }
  
  if (card.type === 'wild') return true;
  if (card.color === state.currentColor) return true;
  if (card.value === top.value) return true;
  return false;
}

function isStackCard(card, stackType) {
  if (stackType === 'draw2') return card.value === 'draw2' || card.value === 'wild4';
  if (stackType === 'wild4') return card.value === 'wild4';
  return false;
}

function handleUnoClaim(claimerId, targetId) {
  const ts = gameState.unoUnprotected[targetId];
  if (ts && (Date.now() - ts) < 5000) {
    // Penalty: target draws 2
    const targetIdx = players.findIndex(p=>p.id===targetId);
    if (targetIdx >= 0) {
      for (let i=0;i<2;i++) {
        if (gameState.deck.length===0) reshuffleDiscard();
        if (gameState.deck.length>0) gameState.hands[targetIdx].push(gameState.deck.pop());
      }
      gameState.unoUnprotected[targetId] = null;
      broadcastNotif(players[targetIdx].name + ' kena penalti +2 (lupa UNO!)', 'danger');
    }
  }
}

function handleWin(winnerIdx) {
  const winnerName = players[winnerIdx].name;
  wins[winnerName] = (wins[winnerName] || 0) + 1;
  localStorage.setItem('uno_wins', JSON.stringify(wins));
  broadcastNotif(winnerName + ' MENANG!', 'success');
  
  setTimeout(() => {
    showVictory(winnerIdx);
  }, 800);
}

function broadcastNotif(msg, kind) {
  showNotif(msg, kind);
  if (isHost) {
    sendToAll({type:'notification', msg, kind});
  }
}

// =================== UI ===================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function setStatus(msg) {
  document.getElementById('statusMsg').innerHTML = msg;
}

function showNotif(msg, kind='info') {
  const c = document.getElementById('notifContainer');
  const div = document.createElement('div');
  div.className = 'notif ' + kind;
  div.textContent = msg;
  c.appendChild(div);
  setTimeout(() => div.remove(), 3100);
}

function startGameUI() {
  // Reset hand snapshot so new deal animates fresh
  _lastHandIds = '';
  _lastTurnForHand = -1;
  _lastStackForHand = -1;
  showScreen('gameScreen');
  document.getElementById('myNameTag').textContent = myName;
  renderGame(true); // true = force deal animation
}

function renderGame(forceAnimate) {
  if (!gameState) return;
  renderOpponents();
  renderDiscardPile();
  renderHand(forceAnimate);
  renderInfoBar();
  updateTurnIndicator();
  document.getElementById('deckCount').textContent = gameState.deck.length + ' CARDS';
}

function renderInfoBar() {
  const gs = gameState;
  const dir = gs.direction === 1 ? '⟳ CLOCKWISE' : '⟲ COUNTER';
  document.getElementById('directionBadge').textContent = dir;

  const cb = document.getElementById('currentColorBadge');
  cb.className = 'color-badge ' + (gs.currentColor || 'wild');
  cb.textContent = colorLabel(gs.currentColor);

  const sb = document.getElementById('stackBadge');
  if (gs.stackPile > 0) {
    sb.style.display = 'block';
    sb.textContent = '+' + gs.stackPile + ' STACK!';
  } else {
    sb.style.display = 'none';
  }
}

function colorLabel(c) {
  return {red:'MERAH',blue:'BIRU',green:'HIJAU',yellow:'KUNING',wild:'WILD'}[c] || 'WILD';
}

function updateTurnIndicator() {
  const ti = document.getElementById('turnIndicator');
  const isMyTurn = gameState.currentTurn === myIndex;
  if (isMyTurn) {
    ti.className = 'turn-indicator my-turn';
    ti.textContent = '⚡ GILIRAN KAMU!';
    // Show UNO button if needed
    const myHand = gameState.hands[myIndex];
    if (myHand && myHand.length === 2) {
      document.getElementById('btnUno').classList.add('show');
    } else {
      document.getElementById('btnUno').classList.remove('show');
    }
  } else {
    ti.className = 'turn-indicator other-turn';
    const name = players[gameState.currentTurn]?.name || '???';
    ti.textContent = '⏳ ' + name + '...';
    document.getElementById('btnUno').classList.remove('show');
  }
}

function renderOpponents() {
  const area = document.getElementById('opponentsArea');
  area.innerHTML = '';
  for (let i = 0; i < players.length; i++) {
    if (i === myIndex) continue;
    const p = players[i];
    const hand = gameState.hands[i] || [];
    const isActive = gameState.currentTurn === i;
    const cardCount = hand.length;

    const slot = document.createElement('div');
    slot.className = 'opponent-slot' + (isActive ? ' active-turn' : '');

    const unoAlert = cardCount === 1 ? ' uno-alert' : '';
    slot.innerHTML = `
      <div class="opp-name">${p.name}</div>
      <div class="opp-cards">${hand.slice(0,10).map(()=>`<div class="opp-card-back"></div>`).join('')}</div>
      <div class="opp-count${unoAlert}">${cardCount}</div>
      ${cardCount === 1 ? `<div style="font-size:9px;color:var(--neon-pink);font-family:'Orbitron';letter-spacing:1px;cursor:pointer" onclick="catchUno('${p.id}')">TANGKAP!</div>` : ''}
    `;
    area.appendChild(slot);
  }
}

function renderDiscardPile() {
  const top = gameState.discardPile[gameState.discardPile.length-1];
  const face = document.getElementById('discardFace');
  const card = document.getElementById('discardCard');
  if (!top) return;

  card.className = 'card card-' + (top.color==='wild' ? 'wild' : top.color);
  face.innerHTML = buildCardFaceHTML(top, false);
}

function buildCardFaceHTML(card, small) {
  const sz = small ? 'small' : '';
  let valHTML = '';
  const v = card.value;
  
  if (card.type==='wild') {
    valHTML = `<div class="card-value wild-sym">${v==='wild4'?'+4 WILD':'WILD'}</div>`;
  } else if (card.type==='number') {
    valHTML = `<div class="card-value num">${v}</div>`;
  } else {
    // special
    let sym = v==='skip'?'⊘':v==='reverse'?'⇄':'+2';
    valHTML = `<div class="card-value sym">${sym}</div>`;
  }

  let corner = card.type==='wild'?'W':card.value;
  if (card.value==='skip') corner='⊘';
  if (card.value==='reverse') corner='⇄';
  if (card.value==='draw2') corner='+2';
  if (card.value==='wild4') corner='+4';

  return `
    <div class="card-shine"></div>
    <div class="card-inner-oval"></div>
    ${valHTML}
    <div class="card-corner tl">${corner}</div>
    <div class="card-corner br">${corner}</div>
  `;
}

// Track hand for diff-based render
let _lastHandIds = '';
let _lastTurnForHand = -1;
let _lastStackForHand = -1;

function calcOverlap(count) {
  // Dynamic overlap: more cards = more overlap
  const containerW = document.getElementById('handCards')?.offsetWidth || 340;
  const cardW = 60;
  const minGap = -42; // max overlap (many cards)
  const maxGap = 6;   // no overlap (few cards)
  if (count <= 1) return maxGap;
  // Total width needed = cardW + gap*(count-1)
  // Solve: containerW >= cardW*count + gap*(count-1)
  const idealGap = Math.floor((containerW - cardW * count) / Math.max(count - 1, 1));
  return Math.max(minGap, Math.min(maxGap, idealGap));
}

function renderHand(forceAnimate) {
  const container = document.getElementById('handCards');
  const myHand = gameState.hands[myIndex];
  if (!myHand) return;

  const isMyTurn = gameState.currentTurn === myIndex;
  const newHandIds = myHand.map(c=>c.id).join(',');
  const needsFullRebuild = forceAnimate
    || newHandIds !== _lastHandIds
    || isMyTurn !== (_lastTurnForHand === myIndex)
    || gameState.stackPile !== _lastStackForHand;

  if (!needsFullRebuild) return;

  // Detect which card IDs are new (added)
  const oldIds = new Set(_lastHandIds ? _lastHandIds.split(',').map(Number) : []);
  const newIds = new Set(myHand.map(c => c.id));
  const addedIds = [...newIds].filter(id => !oldIds.has(id));

  _lastHandIds = newHandIds;
  _lastTurnForHand = gameState.currentTurn;
  _lastStackForHand = gameState.stackPile;

  container.innerHTML = '';

  const gap = calcOverlap(myHand.length);

  myHand.forEach((card, idx) => {
    const playable = isMyTurn && canPlay(card, gameState);
    const div = document.createElement('div');
    div.className = 'hand-card card-' + (card.color==='wild'?'wild':card.color) + (playable?' playable':' not-playable');
    div.dataset.cardId = card.id;

    // Overlap: first card no margin, rest use negative margin-left
    if (idx > 0) div.style.marginLeft = gap + 'px';
    // z-index increases left to right so rightmost is on top
    div.style.zIndex = idx + 1;

    const face = document.createElement('div');
    face.className = 'card-face';
    face.innerHTML = buildCardFaceHTML(card, true);
    div.appendChild(face);

    div.addEventListener('click', () => playCard(card));

    // Only animate newly added cards (draw) OR on forced deal
    if (forceAnimate || addedIds.includes(card.id)) {
      div.classList.add('dealing');
      div.style.animationDelay = forceAnimate ? (idx * 0.06) + 's' : '0s';
    }

    container.appendChild(div);
  });
}

function addLog(msg) {
  const log = document.getElementById('gameLog');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = msg;
  log.insertBefore(entry, log.firstChild);
  if (log.children.length > 4) log.removeChild(log.lastChild);
  setTimeout(() => entry.remove(), 8000);
}

// =================== INTERACTIONS ===================
function playCard(card) {
  if (gameState.currentTurn !== myIndex) return;
  if (!canPlay(card, gameState)) {
    showNotif('Kartu tidak valid!', 'warn');
    return;
  }

  // Animate
  animateCardPlay(card, () => {
    if (card.type === 'wild') {
      pendingColorCard = card;
      document.getElementById('colorPicker').classList.remove('hidden');
    } else {
      sendAction({type:'play', cardId:card.id, chosenColor:null});
      if (isHost) {
        applyAction({type:'play', cardId:card.id, chosenColor:null}, myId);
        broadcastState();
        renderGame();
      }
    }
  });
}

function pickColor(color) {
  document.getElementById('colorPicker').classList.add('hidden');
  if (!pendingColorCard) return;
  const card = pendingColorCard;
  pendingColorCard = null;

  sendAction({type:'play', cardId:card.id, chosenColor:color});
  if (isHost) {
    applyAction({type:'play', cardId:card.id, chosenColor:color}, myId);
    broadcastState();
    renderGame();
  }
}

function drawFromDeck() {
  if (gameState.currentTurn !== myIndex) {
    showNotif('Bukan giliran kamu!', 'warn');
    return;
  }
  animateDrawCard(() => {
    sendAction({type:'draw'});
    if (isHost) {
      applyAction({type:'draw'}, myId);
      broadcastState();
      renderGame();
    }
  });
}

function callUno() {
  sendAction({type:'uno'});
  if (isHost) {
    applyAction({type:'uno'}, myId);
    broadcastState();
  }
  showNotif('UNO! 🔥', 'danger');
  document.getElementById('btnUno').classList.remove('show');
}

function catchUno(targetId) {
  // Check if target is unprotected
  const ts = gameState?.unoUnprotected?.[targetId];
  if (ts && (Date.now() - ts) < 5000) {
    sendAction({type:'callUno', targetId});
    if (isHost) {
      applyAction({type:'callUno', targetId}, myId);
      broadcastState();
      renderGame();
    }
    showNotif('Ketangkap! Penalti +2 🎉', 'success');
  } else {
    showNotif('Sudah aman / sudah panggil UNO', 'warn');
  }
}

function sendAction(action) {
  if (isHost) return; // Host handles locally
  const conn = connections[0];
  if (conn) sendTo(conn, {type:'gameAction', action, playerId:myId});
}

// =================== ANIMATIONS ===================
function animateCardPlay(card, cb) {
  // Find the card element in hand
  const handCard = document.querySelector(`.hand-card[data-card-id="${card.id}"]`);
  const discardEl = document.getElementById('discardCard');
  
  if (!handCard || !discardEl) { cb(); return; }

  const hRect = handCard.getBoundingClientRect();
  const dRect = discardEl.getBoundingClientRect();

  // Create flying card
  const fly = document.createElement('div');
  fly.className = 'card-fly card-' + (card.color==='wild'?'wild':card.color);
  fly.style.cssText = `
    left:${hRect.left}px; top:${hRect.top}px;
    width:${hRect.width}px; height:${hRect.height}px;
    position:fixed; border-radius:10px; z-index:300;
    transition: all 0.35s cubic-bezier(0.25,0.46,0.45,0.94);
    overflow:hidden;
  `;
  const face = document.createElement('div');
  face.className = 'card-face';
  face.innerHTML = buildCardFaceHTML(card, true);
  fly.appendChild(face);
  document.body.appendChild(fly);

  handCard.style.opacity = '0';
  
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fly.style.left = dRect.left + 'px';
      fly.style.top = dRect.top + 'px';
      fly.style.width = dRect.width + 'px';
      fly.style.height = dRect.height + 'px';
      fly.style.transform = 'rotate(5deg) scale(1.1)';
    });
  });

  setTimeout(() => {
    fly.remove();
    cb();
    renderGame();
  }, 380);
}

function animateDrawCard(cb) {
  const deckEl = document.getElementById('deckCard');
  const handEl = document.getElementById('handCards');
  if (!deckEl || !handEl) { cb(); return; }

  const dRect = deckEl.getBoundingClientRect();
  const hRect = handEl.getBoundingClientRect();

  const fly = document.createElement('div');
  fly.className = 'card-fly deck-card';
  fly.style.cssText = `
    left:${dRect.left}px; top:${dRect.top}px;
    width:${dRect.width}px; height:${dRect.height}px;
    position:fixed; border-radius:10px; z-index:300;
    transition: all 0.3s cubic-bezier(0.25,0.46,0.45,0.94);
    overflow:hidden; background:linear-gradient(145deg,#0a0a1a,#1a1a3a);
    border:2px solid rgba(0,245,255,0.5); display:flex; align-items:center; justify-content:center;
  `;
  fly.innerHTML = '<div class="deck-logo" style="font-family:Orbitron;font-weight:900;font-size:16px;background:linear-gradient(135deg,#00f5ff,#ff006e);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">UNO</div>';
  document.body.appendChild(fly);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fly.style.left = (hRect.right - 70) + 'px';
      fly.style.top = (hRect.top + hRect.height/2 - 45) + 'px';
      fly.style.transform = 'rotate(-10deg) scale(0.9)';
      fly.style.opacity = '0.7';
    });
  });

  setTimeout(() => { fly.remove(); cb(); renderGame(); }, 320);
}

// =================== VICTORY ===================
function showVictory(winnerIdx) {
  const winnerName = players[winnerIdx]?.name || '???';
  const isMe = winnerIdx === myIndex;

  document.getElementById('victoryTitle').textContent = isMe ? 'YOU WIN!' : 'GAME OVER';
  document.getElementById('victoryWinner').textContent = '🏆 WINNER: ' + winnerName;

  const scoresEl = document.getElementById('victoryScores');
  scoresEl.innerHTML = players.map((p,i) => {
    const hand = gameState.hands[i] || [];
    const winsCount = wins[p.name] || 0;
    return `<div class="score-row">
      <span class="score-name">${i===winnerIdx?'🏆 ':''} ${p.name}</span>
      <span class="score-pts">${hand.length} kartu | ${winsCount}W</span>
    </div>`;
  }).join('');

  document.getElementById('victoryStatus').textContent = '';
  showScreen('victoryScreen');
}

function requestRestart() {
  restartVotes[myId] = true;
  document.getElementById('victoryStatus').textContent = 'Menunggu semua pemain...';
  if (isHost) {
    sendToAll({type:'restart', playerId:myId});
    const allVoted = players.every(p => restartVotes[p.id]);
    if (allVoted || players.length === 1) {
      restartVotes = {};
      hostStartGame();
    }
  } else {
    if (connections[0]) sendTo(connections[0], {type:'restart', playerId:myId});
  }
}

function backToMenu() {
  peer?.destroy();
  peer = null;
  connections = [];
  players = [];
  gameState = null;
  isHost = false;
  roomCode = '';
  restartVotes = {};
  document.getElementById('roomDisplay').classList.remove('show');
  document.getElementById('waitingPlayers').style.display = 'none';
  document.getElementById('startBtnWrap').style.display = 'none';
  document.getElementById('roomCodeInput').value = '';
  setStatus('');
  showScreen('menuScreen');
}

// =================== INIT ===================
showScreen('menuScreen');

// Lightweight poll: only re-render non-hand parts if state changed
let _lastTurnPoll = -1;
let _lastStackPoll = -1;
let _lastColorPoll = '';
let _lastFinished = false;
setInterval(() => {
  if (!gameState || gameState.finished) return;
  const turnChanged = gameState.currentTurn !== _lastTurnPoll;
  const stackChanged = gameState.stackPile !== _lastStackPoll;
  const colorChanged = gameState.currentColor !== _lastColorPoll;
  if (turnChanged || stackChanged || colorChanged) {
    _lastTurnPoll = gameState.currentTurn;
    _lastStackPoll = gameState.stackPile;
    _lastColorPoll = gameState.currentColor;
    renderOpponents();
    renderDiscardPile();
    renderInfoBar();
    updateTurnIndicator();
    renderHand(false); // diff-based, no forced animation
    document.getElementById('deckCount').textContent = gameState.deck.length + ' CARDS';
  }
}, 300);