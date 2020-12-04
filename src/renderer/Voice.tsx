import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import Avatar from './Avatar';
import { GameStateContext, SettingsContext } from './App';
import { AmongUsState, GameState, MapType, Player } from '../main/GameReader';
import Peer from 'simple-peer';
import { ipcRenderer, remote } from 'electron';
import VAD from './vad';
import { ISettings } from './Settings';
import * as Maps from './Maps';
import LobbySettings, { ILobbySettings } from './LobbySettings';

interface PeerConnections {
	[peer: string]: Peer.Instance;
}
interface PeerAudio {
	element: HTMLAudioElement;
	gain: GainNode;
	pan: PannerNode;
	camsGain: GainNode;
	muffledGain: GainNode;
}
interface AudioElements {
	[peer: string]: PeerAudio;
}

interface SocketIdMap {
	[socketId: string]: number;
}

interface ConnectionStuff {
	socket: typeof Socket;
	stream: MediaStream;
	gain: GainNode;
	pushToTalk: boolean;
	pressingPushToTalk: boolean;
	deafened: boolean;
	muted: boolean;
	deadDeafened: boolean;
	livingDeafened: boolean;
}

interface OtherTalking {
	[playerId: number]: boolean; // isTalking
}

interface OtherDead {
	[playerId: number]: boolean; // isDead
}

// function clamp(number: number, min: number, max: number): number {
// 	if (min > max) {
// 		let tmp = max;
// 		max = min;
// 		min = tmp;
// 	}
// 	return Math.max(min, Math.min(number, max));
// }

// function mapNumber(n: number, oldLow: number, oldHigh: number, newLow: number, newHigh: number): number {
// 	return clamp((n - oldLow) / (oldHigh - oldLow) * (newHigh - newLow) + newLow, newLow, newHigh);
// }

function calculateVoiceAudio(state: AmongUsState, settings: ISettings, me: Player, other: Player, audio: PeerAudio): void {
	const audioContext = audio.pan.context;
	audio.pan.positionZ.setValueAtTime(-0.5, audioContext.currentTime);
	let panPos: Array<number>;
	const dist = distSq(me.x, me.y, other.x, other.y);
	if (state.gameState === GameState.DISCUSSION || state.gameState === GameState.LOBBY) {
		panPos = [0, 0];
	} else {
		if (settings.stereo) {
			panPos = [
				(other.x - me.x),
				(other.y - me.y)
			];
		} else {
			panPos = [0, Math.sqrt(dist)];
		}
	}
	const maxDist = 6 * 6;
	let g: number;
	let gCams = 0;
	if (state.gameState === GameState.LOBBY) {
		g = 1;
	} else if (state.gameState === GameState.MENU) {
		g = 0;
	//} else if (other.inVent) {
	} else if ((!me.isImpostor || !me.inVent) && other.inVent) {
		g = 0;
	} else if (other.isDead) {
		g = me.isDead && dist <= maxDist ? 1 : 0;
	} else if (state.gameState === GameState.DISCUSSION) {
		g = 1;
	} else if (state.gameState === GameState.TASKS) {
		let map = Maps.Empty;
		switch (state.map) {
			case MapType.THE_SKELD:
				map = Maps.TheSkeld;
				break;
			case MapType.MIRA_HQ:
				map = Maps.MiraHq;
				break;
			case MapType.POLUS:
				map = Maps.Polus;
				break;
		}
		if (dist > maxDist) {
			g = 0;
		} else if (me.isDead) {
			g = 1;
		} /*else if (state.isCommsSabotaged) {
			g = 0;
		}*/ else {
			g = 1 - map.blocked(state, me.x, me.y, other.x, other.y);
		}
		if (g < 1 && !state.isCommsSabotaged && state.viewingCameras !== 0) {
			const r = 3;
			for (let i = 0; i < map.cameras.length; i++) {
				if ((state.viewingCameras & (1 << i)) === 0) continue;
				const cam = map.cameras[i];
				const dist = distSq(cam[0], cam[1], other.x, other.y);
				if (dist < r * r) {
					gCams = 1 - Math.sqrt(dist) / r;
					break;
				}
			}
		}
	} else {
		g = 1;
	}
	if (gCams !== 0 && audio.camsGain.gain.value < 1) {
		audio.camsGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.1);
	} else if (gCams === 0 && audio.camsGain.gain.value > 0) {
		audio.camsGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
	}
	if (g === 0.5) {
		audio.muffledGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.015);
		audio.gain.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
	} else {
		if (audio.muffledGain.gain.value > 0) {
			audio.muffledGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
		}
		audio.gain.gain.setTargetAtTime(g, audioContext.currentTime, 0.015);
	}
	if (g > 0) {
		if (isNaN(panPos[0])) panPos[0] = 999;
		if (isNaN(panPos[1])) panPos[1] = 999;
		panPos[0] = Math.min(999, Math.max(-999, panPos[0]));
		panPos[1] = Math.min(999, Math.max(-999, panPos[1]));
		audio.pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		audio.pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);
	}
}

function distSq(x0: number, y0: number, x1: number, y1: number): number {
	const dx = x0 - x1;
	const dy = y0 - y1;
	return dx * dx + dy * dy;
}

function createSecuritySpeaker(context: AudioContext, destination: AudioNode = context.destination): AudioNode {
	// https://stackoverflow.com/a/52472603/2782338
	function createDistortionCurve(amount: number) {
		const sampleCount = 1024;
		const curve = new Float32Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
				const x = 2 * i / sampleCount - 1;
				curve[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x));
		}
		return curve;
	} 
	const highshelf = context.createBiquadFilter();
	highshelf.type = 'highshelf';
	highshelf.frequency.value = 1800;
	highshelf.gain.value = -6;
	highshelf.Q.value = 1;
	const highpass = context.createBiquadFilter();
	highpass.type = 'highpass';
	highpass.frequency.value = 1000;
	highpass.Q.value = 1;
	const distortion = context.createWaveShaper();
	distortion.curve = createDistortionCurve(3);
	distortion.oversample = '4x';
	highpass.connect(distortion);
	const gain = context.createGain();
	gain.gain.value = 0.6;
	distortion.connect(highshelf);
	highshelf.connect(gain);
	gain.connect(destination);
	return highpass;
}

export default function Voice() {
	const [settings] = useContext(SettingsContext);
	const [lobbySettings, setLobbySettings] = useState<ILobbySettings>({});
	const settingsRef = useRef<ISettings>(settings);
	const gameState = useContext(GameStateContext);
	let { lobbyCode: displayedLobbyCode } = gameState;
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';
	const [talking, setTalking] = useState(false);
	const [socketPlayerIds, setSocketPlayerIds] = useState<SocketIdMap>({});
	const [connect, setConnect] = useState<({ connect: (lobbyCode: string, playerId: number) => void }) | null>(null);
	const [otherTalking, setOtherTalking] = useState<OtherTalking>({});
	const [otherDead, setOtherDead] = useState<OtherDead>({});
	const audioElements = useRef<AudioElements>({});
	const audioOut = useMemo<({ctx: AudioContext, dest: AudioNode, cams: AudioNode, muffled: AudioNode })>(() => {
		const ctx = new AudioContext();
		const dest = ctx.destination;
		const compressor = ctx.createDynamicsCompressor();
		compressor.threshold.value = -10;
		compressor.ratio.value = 3;
		compressor.attack.value = 0;
		compressor.release.value = 0.25;
		compressor.connect(dest);
		const cams = createSecuritySpeaker(ctx, compressor);
		cams.connect(compressor);
		const muffled = ctx.createBiquadFilter();
		muffled.type = 'lowpass';
		muffled.frequency.value = 800;
		muffled.Q.value = 1;
		muffled.connect(compressor);
		return { ctx, dest: compressor, cams, muffled };
	}, []);

	const [deafenedState, setDeafened] = useState(false);
	const [mutedState, setMuted] = useState(false);
	const [deadDeafenedState, setDeadDeafened] = useState(false);
	const [livingDeafenedState, setLivingDeafened] = useState(false);
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		if (!connectionStuff.current.stream) return;
		connectionStuff.current.stream.getAudioTracks()[0].enabled = !settings.pushToTalk;
		connectionStuff.current.pushToTalk = settings.pushToTalk;
	}, [settings.pushToTalk]);

	useEffect(() => {
		settingsRef.current = settings;
	}, [settings]);

	useEffect(() => {
		if (gameState.gameState === GameState.LOBBY) {
			setOtherDead({});
		} else if (gameState.gameState !== GameState.TASKS) {
			if (!gameState.players) return;
			setOtherDead(old => {
				for (let player of gameState.players) {
					old[player.id] = player.isDead || player.disconnected;
				}
				return { ...old };
			});
		}
	}, [gameState.gameState]);

	// const [audioOut.ctx] = useState<audioOut.ctx>(() => new audioOut.ctx());
	const connectionStuff = useRef<ConnectionStuff>({ pushToTalk: settings.pushToTalk, deafened: false } as any);
	useEffect(() => {
		if (connectionStuff.current.gain) {
			connectionStuff.current.gain.gain.value = settings.microphoneGain;
		}
	}, [ settings.microphoneGain ]);

	useEffect(() => {
		// Connect to voice relay server
		let url;
		try {
			url = new URL(settings.server);
		} catch (e) {
			remote.dialog.showErrorBox('Invalid URL', 'Bad voice server url:\n\n' + settings.server);
			return;
		}
		const socketUri = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
		connectionStuff.current.socket = io(socketUri, { transports: ['websocket'] });
		const { socket } = connectionStuff.current;

		socket.on('connect', () => {
			setConnected(true);
			console.log(`connected: ${socketUri}`);
		});
		socket.on('disconnect', () => {
			setConnected(false);
			console.log('disconnected');
		});
		
		// Initialize variables
		let audioListener: any;
		let audio: boolean | MediaTrackConstraints = true;

		// Get microphone settings
		if (settings.microphone.toLowerCase() !== 'default') {
			audio = { deviceId: settings.microphone };
		}

		function openMic(successCallback: NavigatorUserMediaSuccessCallback) {
			navigator.getUserMedia({ video: false, audio }, successCallback, error => {
				console.error(error);
				remote.dialog.showErrorBox('Error', 'Couldn\'t connect to your microphone:\n' + error);
			});
		}

		//function checkMicMute(pressing: boolean = false) {
		function checkMicMute(source: number) {
			if (!myPlayer?.isDead) {
				connectionStuff.current.deadDeafened = false;
				connectionStuff.current.livingDeafened = false;
			}

			if (!connectionStuff.current.deafened && connectionStuff.current.deadDeafened && connectionStuff.current.livingDeafened || // if both living and dead are deafened, switch to full deafen
			connectionStuff.current.deafened && (connectionStuff.current.deadDeafened || connectionStuff.current.livingDeafened) && source == 1) { // if dead or living are deafened and full deafen is pressed, remove other deafens
				connectionStuff.current.deafened = true;
				connectionStuff.current.deadDeafened = false;
				connectionStuff.current.livingDeafened = false;
			}
			else if (connectionStuff.current.deafened && (connectionStuff.current.deadDeafened || connectionStuff.current.livingDeafened)) { // if full deafened and dead or living deafen are pressed, exit full deafen and deafen living or dead respectively
				connectionStuff.current.deafened = false;
				connectionStuff.current.deadDeafened = !connectionStuff.current.deadDeafened;
				connectionStuff.current.livingDeafened = !connectionStuff.current.livingDeafened;
			}

			if (!connectionStuff.current.stream) return;

			if (settings.pushToTalk) {
				//stream.getAudioTracks()[0].enabled = !connectionStuff.current.deafened && (!myPlayer?.isDead || !connectionStuff.current.deadDeafened) && pressing;
				connectionStuff.current.stream.getAudioTracks()[0].enabled = !connectionStuff.current.deafened && (!myPlayer?.isDead || !connectionStuff.current.deadDeafened) && connectionStuff.current.pressingPushToTalk;
			}
			else {
				connectionStuff.current.stream.getAudioTracks()[0].enabled = !connectionStuff.current.deafened && (!myPlayer?.isDead || !connectionStuff.current.deadDeafened) && !connectionStuff.current.muted;
			}

			setDeafened(connectionStuff.current.deafened);
			setMuted(connectionStuff.current.muted);
			setDeadDeafened(connectionStuff.current.deadDeafened);
			setLivingDeafened(connectionStuff.current.livingDeafened);
		}

		const toggleDeafen = () => {
			connectionStuff.current.deafened = !connectionStuff.current.deafened;
			checkMicMute(1);
		};

		const toggleMute = () => {
			connectionStuff.current.muted = !connectionStuff.current.muted;
			checkMicMute(2);
		};
		const toggleDeafenDead = () => {
			if (!myPlayer?.isDead) {
				return;
			}
			connectionStuff.current.deadDeafened = !connectionStuff.current.deadDeafened;
			checkMicMute(3);
		};
		const toggleDeafenLiving = () => {
			if (!myPlayer?.isDead) {
				return;
			}
			connectionStuff.current.livingDeafened = !connectionStuff.current.livingDeafened;
			checkMicMute(4);
		};
		const pushToTalk = (_: any, pressing: boolean) => {
			/*if (!connectionStuff.current.pushToTalk) return;
			if (!connectionStuff.current.deafened) {
				stream.getAudioTracks()[0].enabled = pressing;
			}*/
			connectionStuff.current.pressingPushToTalk = pressing;
			checkMicMute(5);
			// console.log(stream.getAudioTracks()[0].enabled);
		};

		let playerCount = gameState?.players?.length;
		const gameStateUpdate = (_: any, newState: AmongUsState) => {
			checkMicMute(6);

			if (playerCount !== newState.players.length && newState.lobbyCode !== 'MENU') {
				playerCount = newState.players.length;

				socket.emit('lobbyPlayerCount', newState.lobbyCode, playerCount);
			}
		};

		ipcRenderer.on('toggleDeafen', toggleDeafen);
		ipcRenderer.on('toggleMute', toggleMute);
		ipcRenderer.on('toggleDeafenDead', toggleDeafenDead);
		ipcRenderer.on('toggleDeafenLiving', toggleDeafenLiving);
		ipcRenderer.on('pushToTalk', pushToTalk);
		ipcRenderer.on('gameState', gameStateUpdate);

		openMic(async (stream) => {
			connectionStuff.current.stream = stream;
			
			const peerConnections: PeerConnections = {};
			audioElements.current = {};

			const audioTrack = stream.getAudioTracks()[0];

			audioTrack.enabled = !settings.pushToTalk;

			checkMicMute(0);

			audioTrack.addEventListener('ended', () => {
				remote.dialog.showMessageBox(remote.getCurrentWindow(),
					{
						title: 'Audio Disconnected',
						message: 'The current audio device was disconnected, choose \'Reload\' once reconnected or switch to different device.',
						buttons: ['Change settings', 'Reload'],
						defaultId: 1
					}
				)
				.then(res => {
					if (res.response === 1) {
						remote.getCurrentWindow().reload();
					}
				});
			});

			const ac = new AudioContext();
			let peerStream: MediaStream;
			let streamNode: AudioNode;
			if (true) { // settings.microphoneGain !== 1
				const gain = ac.createGain();
				connectionStuff.current.gain = gain;
				gain.gain.value = settings.microphoneGain;
				const dest = ac.createMediaStreamDestination();
				ac.createMediaStreamSource(stream).connect(gain).connect(dest);
				peerStream = dest.stream;
				streamNode = gain;
			} else {
				peerStream = stream;
				streamNode = ac.createMediaStreamSource(stream);
			}
			audioListener = new VAD(ac, streamNode, undefined, {
				onVoiceStart: () => setTalking(true),
				onVoiceStop: () => setTalking(false),
				noiseCaptureDuration: 1,
			});

			function disconnectPeer(peer: string) {
				const connection = peerConnections[peer];
				if (!connection) return;
				connection.destroy();
				delete peerConnections[peer];
				if (audioElements.current[peer]) {
					document.body.removeChild(audioElements.current[peer].element);
					audioElements.current[peer].pan.disconnect();
					audioElements.current[peer].gain.disconnect();
					audioElements.current[peer].camsGain.disconnect();
					delete audioElements.current[peer];
				}
			}

			const connect = (lobbyCode: string, playerId: number) => {
				socket.emit('leave');
				Object.keys(peerConnections).forEach(k => {
					disconnectPeer(k);
				});
				setSocketPlayerIds({});
				if (lobbyCode === 'MENU') return;
				socket.emit('join', lobbyCode, playerId);
				socket.emit('lobbyPlayerCount', lobbyCode, gameState?.players?.length ?? 1);
			};
			setConnect({ connect });
			function createPeerConnection(peer: string, initiator: boolean) {
				disconnectPeer(peer);

				const connection = new Peer({
					stream: peerStream, initiator, config: {
						iceServers: [
							{ 'urls': ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19305'] },
						]
					}
				});
				peerConnections[peer] = connection;

				connection.on('stream', (stream: MediaStream) => {
					let audio = document.createElement('audio');
					document.body.appendChild(audio);
					audio.srcObject = stream;
					if (settings.speaker.toLowerCase() !== 'default')
						(audio as any).setSinkId(settings.speaker);

					var source = audioOut.ctx.createMediaStreamSource(stream);
					let gain = audioOut.ctx.createGain();
					let pan = audioOut.ctx.createPanner();
					pan.refDistance = 0.1;
					pan.panningModel = 'equalpower';
					pan.distanceModel = 'linear';
					//pan.maxDistance = 2.66 * 2;
					pan.maxDistance = 2.4;
					pan.rolloffFactor = 1;

					source.connect(pan);
					pan.connect(gain);
					
					const camsGain = audioOut.ctx.createGain();
					camsGain.gain.value = 0;
					source.connect(camsGain);
					camsGain.connect(audioOut.cams);
					
					const muffledGain = audioOut.ctx.createGain();
					muffledGain.gain.value = 0;
					pan.connect(muffledGain);
					muffledGain.connect(audioOut.muffled);

					gain.connect(audioOut.dest);
					const vad = new VAD(audioOut.ctx, gain, undefined, {
						onVoiceStart: () => setTalking(true),
						onVoiceStop: () => setTalking(false)
					});

					camsGain.connect(vad.analyser);
					muffledGain.connect(vad.analyser);

					const setTalking = (talking: boolean) => {
						setSocketPlayerIds(socketPlayerIds => {
							setOtherTalking(old => ({
								...old,
								[socketPlayerIds[peer]]: talking && gain.gain.value > 0
							}));
							return socketPlayerIds;
						});
					};
					audioElements.current[peer] = { element: audio, gain, pan, camsGain, muffledGain };
				});
				connection.on('signal', (data) => {
					socket.emit('signal', {
						data,
						to: peer
					});
				});
				connection.on('error', (error) => {
					console.log(error);
					if (initiator) {
						remote.dialog.showErrorBox('Connection Error', `A voice connection error occurred: ${error.name}\n\n${error.message}`);
					}
				});
				connection.on('close', () => {
					console.log('Closing peer connection');
					disconnectPeer(socket.id);
				});
				return connection;
			}
			socket.on('join', async (peer: string, playerId: number) => {
				createPeerConnection(peer, true);
				setSocketPlayerIds(old => ({ ...old, [peer]: playerId }));
			});
			socket.on('signal', ({ data, from }: any) => {
				let connection: Peer.Instance;
				if (peerConnections[from]) connection = peerConnections[from];
				else connection = createPeerConnection(from, false);
				connection.signal(data);
			});
			socket.on('setId', (socketId: string, id: number) => {
				setSocketPlayerIds(old => ({ ...old, [socketId]: id }));
			})
			socket.on('setIds', (ids: SocketIdMap) => {
				setSocketPlayerIds(ids);
			});
			socket.on('lobbySetting', (setting: string, value: any) => {
				console.log('lobbySetting: ' + setting + ' - ' + value);

				setLobbySettings(old => ({ ...old, [setting]: value }));
			});
			socket.on('lobbySettings', (settings: ILobbySettings) => {
				//console.log('lobbySettings: ' + Object.keys(settings));
				for (let s of Object.keys(settings)) {
					console.log('lobbySetting: ' + s + ' - ' + settings[s]);
				}

				setLobbySettings(settings);
			});
		});

		return () => {
			connectionStuff.current.socket.close();

			audioListener.destroy();

			ipcRenderer.off('toggleDeafen', toggleDeafen);
			ipcRenderer.off('toggleMute', toggleMute);
			ipcRenderer.off('toggleDeafenDead', toggleDeafenDead);
			ipcRenderer.off('toggleDeafenLiving', toggleDeafenLiving);
			ipcRenderer.off('pushToTalk', pushToTalk);
			ipcRenderer.off('gameState', gameStateUpdate);
		}
	}, []);

	const myPlayer = useMemo(() => {
		if (!gameState || !gameState.players) return undefined;
		else return gameState.players.find(p => p.isLocal);
	}, [gameState]);

	const otherPlayers = useMemo(() => {
		let otherPlayers: Player[];
		if (!gameState || !gameState.players || gameState.lobbyCode === 'MENU' || !myPlayer) otherPlayers = [];
		else otherPlayers = gameState.players.filter(p => !p.isLocal);

		let playerSocketIds = {} as any;
		for (let k of Object.keys(socketPlayerIds)) {
			playerSocketIds[socketPlayerIds[k]] = k;
		}
		for (let player of otherPlayers) {
			const audio = audioElements.current[playerSocketIds[player.id]];
			if (audio) {
				calculateVoiceAudio(gameState, settingsRef.current, myPlayer!, player, audio);
				if (connectionStuff.current.deafened || myPlayer?.isDead && (otherDead[player.id] && connectionStuff.current.deadDeafened || !otherDead[player.id] && connectionStuff.current.livingDeafened)) {
					audio.gain.gain.value = 0;
				}
			}
		}

		return otherPlayers;
	}, [gameState, socketPlayerIds]);

	useEffect(() => {
		if (connect?.connect && gameState.lobbyCode && myPlayer?.id !== undefined) {
			connect.connect(gameState.lobbyCode, myPlayer.id);
		}
	}, [connect?.connect, gameState?.lobbyCode]);

	useEffect(() => {
		if (connect?.connect && gameState.lobbyCode && myPlayer?.id !== undefined && gameState.gameState === GameState.LOBBY && (gameState.oldGameState === GameState.DISCUSSION || gameState.oldGameState === GameState.TASKS)) {
			connect.connect(gameState.lobbyCode, myPlayer.id);
		}
	}, [gameState.gameState]);

	useEffect(() => {
		if (connectionStuff.current.socket && myPlayer?.id !== undefined) {
			connectionStuff.current.socket.emit('id', myPlayer.id);
		}
	}, [myPlayer?.id]);
	
	let overlayMode = settings.overlayMode && gameState.gameState !== undefined && gameState.gameState !== GameState.UNKNOWN && gameState.gameState !== GameState.MENU && otherPlayers.length > 0;

	/*const otherPlayersSorted = JSON.parse(JSON.stringify(otherPlayers));
	otherPlayersSorted*/otherPlayers.sort((p1: Player, p2: Player) => {
		let p1Connected = Object.values(socketPlayerIds).includes(p1.id), p2Connected = Object.values(socketPlayerIds).includes(p2.id);
		if(!p1Connected || !p2Connected) return p1Connected ? -1 : 1;

		let p1Dead = otherDead[p1.id], p2Dead = otherDead[p2.id]
		if(p1Dead || p2Dead) return p1Dead && !myPlayer?.isDead ? 1 : -1;

		if (overlayMode) return 0;

		let p1Talking = otherTalking[p1.id], p2Talking = otherTalking[p2.id]
		if(p1Talking || p2Talking) return p1Talking ? -1 : 1;

		return 0;
	});

	/*if (myPlayer?.id !== undefined) {
		let test = JSON.parse(JSON.stringify(myPlayer));
		test.id = "bleh";
		test.name = "Talking"
		otherTalking[test.id] = true;
		otherPlayersSorted.push(myPlayer, test, myPlayer, myPlayer, test, myPlayer, test, myPlayer, test);
	}*/

	return (
		<div className="root">
			<div className="top">
				{myPlayer &&
					<Avatar deafened={deafenedState} muted={mutedState} deadDeafened={deadDeafenedState} livingDeafened={livingDeafenedState} player={myPlayer} borderColor={connected ? '#2ecc71' : '#c0392b'} talking={talking} isAlive={!myPlayer.isDead} size={100} />
					// <div className="avatar" style={{ borderColor: talking ? '#2ecc71' : 'transparent' }}>
					// 	<Canvas src={alive} color={playerColors[myPlayer.colorId][0]} shadow={playerColors[myPlayer.colorId][1]} />
					// </div>
				}
				<div className="right">
					{myPlayer && gameState?.gameState !== GameState.MENU &&
						<span className="username">
							{myPlayer.name}
						</span>
					}
					{gameState.lobbyCode &&
						<span className="code" style={{ background: gameState.lobbyCode === 'MENU' ? 'transparent' : '#3e4346' }}>
							{displayedLobbyCode}
						</span>
					}
				</div>
			</div>
			<hr />
			{
				gameState?.gameState === GameState.LOBBY && otherPlayers.length == 0 &&
				<LobbySettings socket={connectionStuff.current.socket} lobbySettings={lobbySettings}/>
			}
			<div className="otherplayers-container">
				<div className="otherplayers">
					{
						otherPlayers/*Sorted*/.filter((player: Player) => {
							return !overlayMode || otherTalking[player.id];
						}).map((player: Player) => {
							let connected = Object.values(socketPlayerIds).includes(player.id);
							return (
								<Avatar key={player.id} player={player}
									talking={!connected || otherTalking[player.id]}
									borderColor={connected ? '#2ecc71' : '#c0392b'}
									isAlive={!otherDead[player.id]}
									size={40} />
							);
						})
					}
				</div>
			</div>
			{ overlayMode &&
				<hr />
			}
			{
				overlayMode &&
				<div className="otherplayers">
					{
						otherPlayers/*Sorted*/.filter((player: Player) => {
							return !otherTalking[player.id];
						}).map((player: Player) => {
							let connected = Object.values(socketPlayerIds).includes(player.id);
							return (
								<Avatar key={player.id} player={player}
									talking={!connected || otherTalking[player.id]}
									borderColor={connected ? '#2ecc71' : '#c0392b'}
									isAlive={!otherDead[player.id]}
									size={40} />
							);
						})
					}
				</div>
			}
			<div className="reload-app" onMouseUp={() => remote.getCurrentWindow().reload() }>RELOAD</div>
		</div>
	)
}