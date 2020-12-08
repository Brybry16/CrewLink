import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import Avatar from './Avatar';
import { GameStateContext, SettingsContext, LobbySettingsContext } from './App';
import { AmongUsState, GameState, MapType, Player } from '../main/GameReader';
import Peer from 'simple-peer';
import { ipcRenderer, remote } from 'electron';
import VAD from './vad';
import { ISettings } from './Settings';
import * as Maps from './Maps';
import { ILobbySettings, VoiceDistanceModel } from './LobbySettings';
import { ObstructionType } from './Ship';

interface PeerConnections {
	[peer: string]: Peer.Instance;
}
interface PeerAudio {
	element: HTMLAudioElement;
	gain: GainNode;
	gainTarget: number;
	pan: PannerNode;
	muffledGain: GainNode;
	muffledGainTarget: number;
	camsGain: GainNode;
	camsGainTarget: number;
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

function calculateVoiceAudio(state: AmongUsState, settings: ISettings, me: Player, other: Player, audio: PeerAudio, outputGain: number, lobbySettings: ILobbySettings): void {
	const audioContext = audio.pan.context;
	audio.pan.positionZ.setValueAtTime(-0.5, audioContext.currentTime);

	let panPos: Array<number>;
	const dist = distSq(me.x, me.y, other.x, other.y);
	if (state.gameState === GameState.DISCUSSION/* || state.gameState === GameState.LOBBY*/) {
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

	let distanceModel = lobbySettings.voiceDistanceModel;

	//const maxDist = 6 ** 2;
	//const maxDist = (6 * (lobbySettings.voiceRadius / 2.4)) ** 2;
	//const maxDist = (6 * distanceModel == VoiceDistanceModel.Linear ? 1 : (lobbySettings.voiceRadius / 2.4)) ** 2;
	const maxDist = lobbySettings.voiceMaxDistance ** 2;

	let g = state.gameState === GameState.MENU ? 0 : 1; // No voice if not in a match
	let gCams = 0;
	let muffle = false;

	/*if (state.gameState === GameState.MENU) { // No voice if not in a match
		g = 0;
	} else if (state.gameState === GameState.LOBBY || state.gameState === GameState.DISCUSSION) { // Always voice during lobby or discussion
		g = 1;
	} else*/
	if (state.gameState === GameState.DISCUSSION) { // Always voice during lobby or discussion
		g = other.isDead && !me.isDead ? 0 : 1;
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

		let obstruction = ObstructionType.None;

		//console.log(`${other.name} ${other.inVent && (!me.inVent && !me.isDead || !lobbySettings.impostorVentChat)}`)
		if (dist > maxDist) { // Beyond max distance
			const scale = dist / maxDist - 1;
			g = scale < 0.2 ? 1 - scale * 5 : 0; // Todo: Make cutoff less abrupt
		} else if (other.isDead && !me.isDead || // Mute ghosts if not dead
		other.inVent && (!me.inVent && !me.isDead || !lobbySettings.impostorVentChat) || // Other is in vent and current player isn't (dead) or in vent, or vent chat is disabled
		!me.isDead && state?.isCommsSabotaged && lobbySettings.commsSabotageVoice && (!other.isImpostor || !me.isImpostor)) { // Not dead and comms sabotage is active with comms sabotage disabling voice enabled, impostors can still hear and talk
			g = 0;
		} else if (me.inVent && !other.inVent) {
			muffle = true;
		} else {
			/*g = 1 - map.blocked(state, me.x, me.y, other.x, other.y);
			if (g === 1 && me.inVent && !other.inVent) { // Muffle audio from players outside the vent
				g = 0.5;
			}
			else if (g === 0 && lobbySettings.wallObstructedVolume) {
				//g = lobbySettings.wallObstructedVolume === 0.5 ? 0.49 : lobbySettings.wallObstructedVolume;
				g = lobbySettings.wallObstructedVolume;
			}*/

			obstruction = map.blocked(state, me.x, me.y, other.x, other.y);

			if (obstruction === ObstructionType.Window) {
				muffle = lobbySettings.windowObstructedMuffle;
				g = lobbySettings.windowObstructedVolume;
			} else if (obstruction === ObstructionType.Wall || obstruction === ObstructionType.Door) {
				muffle = lobbySettings.wallObstructedMuffle;
				g = lobbySettings.wallObstructedVolume;
			}

			if (me.isDead) muffle = false;
		}

		if (/*g < 1*/(g === 0 || muffle) && !state.isCommsSabotaged && state.viewingCameras !== 0) {
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
	} /*else {
		g = 1;
	}*/

	let gainExponent = distanceModel === VoiceDistanceModel.Exponential ? lobbySettings.exponentialGain : 1;

	g *= gainExponent * outputGain;

	if (gCams !== 0/* && audio.camsGain.gain.value < 1*/ /*&& audio.camsGain.gain.value === 0*/ && audio.camsGain.gain.value < gainExponent) {
		/*audio.camsGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.1);
		audio.camsGain.gain.value = 1;*/
		audio.camsGain.gain.setTargetAtTime(audio.camsGainTarget = gainExponent, audioContext.currentTime, 0.1);
		//audio.camsGain.gain.value = gainExponent;
	} else if (gCams === 0 && audio.camsGain.gain.value > 0) {
		audio.camsGain.gain.setTargetAtTime(audio.camsGainTarget = 0, audioContext.currentTime, 0.015);
		//audio.camsGain.gain.value = 0;
	}

	//if (g === 0.5) {
	/*if (muffle) {
		//audio.muffledGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.015);
		//audio.muffledGain.gain.value = 1;
		let muffleGain = distanceModel === VoiceDistanceModel.Exponential ? 0.25 : 1;
		audio.muffledGain.gain.setTargetAtTime(muffleGain, audioContext.currentTime, 0.015);
		audio.muffledGain.gain.value = muffleGain;

		audio.gain.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
		audio.gain.gain.value = 0;
	} else {
		if (audio.muffledGain.gain.value > 0) {
			audio.muffledGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
			audio.muffledGain.gain.value = 0;
		}

		audio.gain.gain.setTargetAtTime(g, audioContext.currentTime, 0.015);
		audio.gain.gain.value = g;
	}*/

	let muffleGain = muffle ? g : 0;
	g = muffle ? 0 : g;

	if(audio.muffledGainTarget !== muffleGain) audio.muffledGain.gain.setTargetAtTime(audio.muffledGainTarget = muffleGain, audioContext.currentTime, 0.015);
	//audio.muffledGain.gain.value = muffleGain;

	/*if (audio.gain.gain.value === 1)
	{
		console.log('resetting gain');
		audio.gain.gain.value = 0;
	}*/

	if(audio.gainTarget !== g) audio.gain.gain.setTargetAtTime(audio.gainTarget = g, audioContext.currentTime, 0.015);
	//audio.gain.gain.value = g;

	//console.log(audio.gain.gain);

	if (g > 0 || audio.gain.gain.value > 0 || audio.muffledGain.gain.value > 0 || audio.camsGain.gain.value > 0 || audio.gainTarget > 0 || audio.muffledGainTarget > 0 || audio.camsGainTarget > 0) {
		if (isNaN(panPos[0])) panPos[0] = 999;
		if (isNaN(panPos[1])) panPos[1] = 999;

		panPos[0] = Math.min(999, Math.max(-999, panPos[0]));
		panPos[1] = Math.min(999, Math.max(-999, panPos[1]));

		audio.pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		audio.pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);

		audio.pan.distanceModel = distanceModel === VoiceDistanceModel.Linear ? 'linear' : 'exponential';
		audio.pan.maxDistance = lobbySettings.voiceRadius;// * 2;
		//audio.pan.maxDistance = distanceModel == VoiceDistanceModel.Exponential ? lobbySettings.voiceRadius : 2.4;
		//audio.gain.gain.value = audio.gain.gain.value + (lobbySettings.voiceRadius - 0.5) / 1.9;
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
	const [lobbySettings, setLobbySettings] = useContext(LobbySettingsContext);
	const settingsRef = useRef<ISettings>(settings);
	const gameState = useContext(GameStateContext);
	let { lobbyCode: displayedLobbyCode } = gameState;
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';
	const [talking, setTalking] = useState(false);
	const [joinedLobby, setJoinedLobby] = useState<string>('MENU');
	const [socketPlayerIds, setSocketPlayerIds] = useState<SocketIdMap>({});
	const [connect, setConnect] = useState<({ connect: (lobbyCode: string, playerId: number) => void, initiatePeer: (peer: string) => void }) | null>(null);
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
	const connectionStuff = useRef<ConnectionStuff>({ pushToTalk: settings.pushToTalk, pressingPushToTalk: false, deafened: false, muted: false, deadDeafened: false, livingDeafened: false } as any);

	useEffect(() => {
		if (connectionStuff.current.gain) {
			connectionStuff.current.gain.gain.value = settings.inputGain;
		}
	}, [settings.inputGain]);

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
			setJoinedLobby('MENU');
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

		let myPlayer = gameState?.players?.find(p => p.isLocal);
		function checkMicMute(source: number = 0) {
			if (myPlayer?.isDead/* || gameState?.gameState !== GameState.DISCUSSION && gameState?.gameState !== GameState.TASKS*/) {
				connectionStuff.current.deadDeafened = false;
				connectionStuff.current.livingDeafened = false;
			}

			if (!connectionStuff.current.deafened && connectionStuff.current.deadDeafened && connectionStuff.current.livingDeafened || // if both living and dead are deafened, switch to full deafen
			connectionStuff.current.deafened && (connectionStuff.current.deadDeafened || connectionStuff.current.livingDeafened) && source === 1) { // if dead or living are deafened and full deafen is pressed, remove other deafens
				connectionStuff.current.deafened = true;
				connectionStuff.current.deadDeafened = false;
				connectionStuff.current.livingDeafened = false;
			}
			else if (connectionStuff.current.deafened && (connectionStuff.current.deadDeafened || connectionStuff.current.livingDeafened)) { // if full deafened and dead or living deafen are pressed, exit full deafen and deafen living or dead respectively
				connectionStuff.current.deafened = false;
				connectionStuff.current.deadDeafened = !connectionStuff.current.deadDeafened;
				connectionStuff.current.livingDeafened = !connectionStuff.current.livingDeafened;
			}

			if (connectionStuff.current.deafened && source === 2) { // If deafened and toggling mute, undo deafen and mute.
				connectionStuff.current.deafened = false;
				connectionStuff.current.muted = false;
			}

			if (!connectionStuff.current.stream) return;

			if (settings.pushToTalk) {
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
			connectionStuff.current.deadDeafened = !connectionStuff.current.deadDeafened;

			checkMicMute();
		};
		const toggleDeafenLiving = () => {
			connectionStuff.current.livingDeafened = !connectionStuff.current.livingDeafened;

			checkMicMute();
		};
		const pushToTalk = (_: any, pressing: boolean) => {
			/*if (!connectionStuff.current.pushToTalk) return;
			if (!connectionStuff.current.deafened) {
				stream.getAudioTracks()[0].enabled = pressing;
			}*/

			connectionStuff.current.pressingPushToTalk = pressing;

			checkMicMute();
			// console.log(stream.getAudioTracks()[0].enabled);
		};

		let playerCount = gameState?.players?.length;
		const gameStateUpdate = (_: any, newState: AmongUsState) => {
			myPlayer = newState?.players?.find(p => p.isLocal);

			checkMicMute();

			if (playerCount !== newState.players.length && newState.lobbyCode !== 'MENU') {
				playerCount = newState.players.length;

				socket.emit('lobbyPlayerCount', newState.lobbyCode, playerCount);
			}
		};

		const lobbySettingUpdate = (setting: any, value: any) => {
			console.log(`lobbySettingUpdate: ${setting} - ${value}`);
			socket.emit('setLobbySetting', setting, value);
		};

		ipcRenderer.on('toggleDeafen', toggleDeafen);
		ipcRenderer.on('toggleMute', toggleMute);
		ipcRenderer.on('toggleDeafenDead', toggleDeafenDead);
		ipcRenderer.on('toggleDeafenLiving', toggleDeafenLiving);
		ipcRenderer.on('pushToTalk', pushToTalk);
		ipcRenderer.on('gameState', gameStateUpdate);
		ipcRenderer.on('lobbySettingUpdate', lobbySettingUpdate);
	
		openMic(async (stream) => {
			connectionStuff.current.stream = stream;

			const peerConnections: PeerConnections = {};

			audioElements.current = {};

			const audioTrack = stream.getAudioTracks()[0];

			audioTrack.enabled = !settings.pushToTalk;

			checkMicMute();

			audioTrack.addEventListener('ended', () => {
				remote.dialog.showMessageBox(
					{
						type: 'error',
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
			if (true) { // settings.inputGain !== 1
				const gain = ac.createGain();
				connectionStuff.current.gain = gain;

				gain.gain.value = settings.inputGain;

				const dest = ac.createMediaStreamDestination();
				const src = ac.createMediaStreamSource(stream);
				src.connect(gain).connect(dest);

				peerStream = dest.stream;
				streamNode = gain;

				/*const processor = ac.createScriptProcessor(2048, 1, 1);
				processor.connect(ac.destination);
				src.connect(processor);

				const minUpdateRate = 0;//50;
        		let lastRefreshTime = 0;

				processor.addEventListener('audioprocess', (event: AudioProcessingEvent) => {
					// limit update frequency
					if (event.timeStamp - lastRefreshTime < minUpdateRate) return;
		
					// update last refresh time
					lastRefreshTime = event.timeStamp;
		
					const input = event.inputBuffer.getChannelData(0);
					const total = input.reduce((acc, val) => acc + Math.abs(val), 0);
					const rms = Math.sqrt(total / input.length);
					//setRms(rms);
					//console.log('rms: ' + rms);
					let g = rms > 0.05 ? settings.inputGain : 0;
					if(gain.gain.value === 0 || gain.gain.value === 1) {
						gain.gain.setTargetAtTime(g, ac.currentTime, 0.015);
					}
					console.log(gain.gain.value);
				});*/
				//VAD.onUpdate
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

				setJoinedLobby(lobbyCode);

				if (lobbyCode === 'MENU') return;

				socket.emit('join', lobbyCode, playerId);
				socket.emit('lobbyPlayerCount', lobbyCode, gameState?.players?.length ?? 1);
				
				console.log(`Joining lobby ${lobbyCode}: ${playerId}`);
			};

			const initiatePeer = (peer: string) => {
				const connection = peerConnections[peer];
				if (!connection || connection.destroyed) {
					createPeerConnection(peer, true);	
				}
			};
			setConnect({ connect, initiatePeer });

			function createPeerConnection(peer: string, initiator: boolean) {
				disconnectPeer(peer);

				console.log(`Establishing connection to ${peer}, initator: ${initiator}`);
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
					/*pan.distanceModel = 'linear'; //exponential
					//pan.maxDistance = 2.66 * 2;
					pan.maxDistance = 2.4;*/
					pan.distanceModel = lobbySettings.voiceDistanceModel === VoiceDistanceModel.Linear ? 'linear' : 'exponential';
					pan.maxDistance = lobbySettings.voiceRadius;// * 2;
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
						onVoiceStart: () => setIsTalking(true),
						onVoiceStop: () => setIsTalkingTimeout(false),
						//noiseCaptureDuration: 1,
					});

					camsGain.connect(vad.analyser);
					muffledGain.connect(vad.analyser);

					let isTalkingTimeout: any = 0;

					const setIsTalkingTimeout = (talking: boolean) => {
						if (isTalkingTimeout) clearTimeout(isTalkingTimeout);
						isTalkingTimeout = setTimeout(() => {
							setIsTalking(talking);
						}, 300);
					};

					const setIsTalking = (talking: boolean) => {
						if (isTalkingTimeout) clearTimeout(isTalkingTimeout);

						isTalkingTimeout = 0;

						setSocketPlayerIds(socketPlayerIds => {
							setOtherTalking(old => ({
								...old,
								[socketPlayerIds[peer]]: talking && (gain.gain.value > 0 || muffledGain.gain.value > 0 || camsGain.gain.value > 0 || audioElements.current[peer].gainTarget > 0 || audioElements.current[peer].muffledGainTarget > 0 || audioElements.current[peer].camsGainTarget > 0)
							}));
							return socketPlayerIds;
						});
					};

					audioElements.current[peer] = { element: audio, gain, gainTarget: 1, pan, muffledGain, muffledGainTarget: 0, camsGain, camsGainTarget: 0 };
				});
				connection.on('signal', (data) => {
					socket.emit('signal', {
						data,
						to: peer
					});
				});
				connection.on('error', (e: any) => {
					console.log(e);
					if (initiator && e.code !== 'ERR_DATA_CHANNEL') {
						if (e.code !== 'ERR_WEBRTC_SUPPORT' && e.code !== 'ERR_SIGNALING') {
							setTimeout(() => {
								createPeerConnection(peer, true);
							}, 500 + Math.random() * 3000 | 0);
						} else {
							remote.dialog.showMessageBox(
								{
									type: 'error',
									title: 'Connection Error',
									message: `A voice connection error occurred: ${e.error.name}\n\n${e.error.message}`
								}
							);
						}
					}
				});
				connection.on('close', () => {
					console.log('Closing peer connection');
					disconnectPeer(socket.id);
				});
				return connection;
			}

			socket.on('join', async (peer: string, playerId: number) => {
				setSocketPlayerIds(old => ({ ...old, [peer]: playerId }));
			});

			socket.on('signal', ({ data, from }: any) => {
				let connection: Peer.Instance;
				if (peerConnections[from] && !peerConnections[from].destroyed) connection = peerConnections[from];
				else connection = createPeerConnection(from, false);
				connection.signal(data);
			});

			socket.on('setId', (socketId: string, id: number) => {
				setSocketPlayerIds(old => ({ ...old, [socketId]: id }));
			})
			socket.on('deleteId', (socketId: string) => {
				setSocketPlayerIds(old => {
					const copy = { ...old };
					delete copy[socketId];
					return copy;
				});
			})
			socket.on('setIds', (ids: SocketIdMap) => {
				setSocketPlayerIds(ids);
			});

			socket.on('lobbySetting', (setting: string, value: any) => {
				//console.log(`lobbySetting: ${setting} - ${value}`);

				setLobbySettings((old: [ILobbySettings]) => ({ ...old, [setting]: value }));
				//lobbySettings[setting] = value;

				//console.log(`lobbySetting set: ${setting} - ${lobbySettings[setting]} ${Object.keys(lobbySettings)}`);
			});
			socket.on('lobbySettings', (settings: ILobbySettings) => {
				//console.log(`lobbySettings: ${Object.keys(settings)}`);
				/*for (let s of Object.keys(settings)) {
					console.log(`lobbySetting: ${s} - ${settings[s]}`);
				}*/

				setLobbySettings(settings);
				//lobbySettings = settings;

				/*console.log(`lobbySettings set: ${Object.keys(lobbySettings)}`);
				for (let s of Object.keys(lobbySettings)) {
					console.log(`lobbySetting set: ${s} - ${lobbySettings[s]}`);
				}*/
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
			ipcRenderer.off('lobbySettingUpdate', lobbySettingUpdate);
		}
	}, []);

	useEffect(() => {
		for (let s of Object.keys(lobbySettings)) {
			console.log(`lobbySetting: ${s} - ${lobbySettings[s]}`);
		}
	}, [lobbySettings]);

	const myPlayer = useMemo(() => {
		return gameState?.players?.find(p => p.isLocal);
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
				if (connectionStuff.current.deafened || myPlayer!.isDead && (otherDead[player.id] && connectionStuff.current.deadDeafened || !otherDead[player.id] && connectionStuff.current.livingDeafened)) {
					audio.gain.gain.value = audio.gainTarget = 0;
					audio.muffledGain.gain.value = audio.muffledGainTarget = 0;
					audio.camsGain.gain.value = audio.camsGainTarget = 0;

					continue;
				}

				calculateVoiceAudio(gameState, settingsRef.current, myPlayer!, player, audio, settings.outputGain, lobbySettings);
			}
		}

		return otherPlayers;
	}, [gameState, socketPlayerIds]);

	// useEffect(() => {
	// 	if (connect?.connect && gameState.lobbyCode && myPlayer?.id !== undefined && gameState.gameState === GameState.LOBBY && (gameState.oldGameState === GameState.DISCUSSION || gameState.oldGameState === GameState.TASKS)) {
	// 		connect.connect(gameState.lobbyCode, myPlayer.id);
	// 	}
	// }, [gameState.gameState]);

	useEffect(() => {
		if (myPlayer?.id === undefined || connected !== true) return;
		
		if (connectionStuff.current.socket) {
			connectionStuff.current.socket.emit('id', myPlayer.id);
		}
		
		const code = gameState?.lobbyCode;
		if (connect?.connect && code && code !== joinedLobby) {
			connect.connect(code, myPlayer.id);
		}
	}, [connect?.connect, myPlayer?.id, gameState?.lobbyCode, connected]);

	useEffect(() => {
		if (myPlayer?.id === undefined || !connect?.initiatePeer) return;
		for (let k of Object.keys(socketPlayerIds)) {
			if (myPlayer.id < socketPlayerIds[k]) {
				connect.initiatePeer(k);
			}
		}
	}, [connect?.initiatePeer, myPlayer?.id, socketPlayerIds]);

	let overlayMode = settings.overlayMode && gameState.gameState !== undefined && gameState.gameState !== GameState.UNKNOWN && gameState.gameState !== GameState.MENU && otherPlayers.length > 0;

	//const otherPlayersSorted = JSON.parse(JSON.stringify(otherPlayers));
	//const otherPlayersSorted = { ...otherPlayers, myPlayer };
	otherPlayers/*Sorted*/.sort((p1: Player, p2: Player) => {
		let p1Connected = Object.values(socketPlayerIds).includes(p1.id), p2Connected = Object.values(socketPlayerIds).includes(p2.id);
		if(!p1Connected || !p2Connected) return p1Connected ? -1 : 1;

		let p1Dead = otherDead[p1.id], p2Dead = otherDead[p2.id]
		//if(p1Dead || p2Dead) return p1Dead && !myPlayer?.isDead ? 1 : -1;
		if(p1Dead || p2Dead) return p1Dead ? 1 : -1;

		/*if (overlayMode) return 0;

		let p1Talking = otherTalking[p1.id], p2Talking = otherTalking[p2.id]
		if(p1Talking || p2Talking) return p1Talking ? -1 : 1;*/

		return 0;
	});

	/*if (myPlayer?.id !== undefined && !otherPlayers[0] && otherPlayers.length == 0) {
		let test = JSON.parse(JSON.stringify(myPlayer));
		test.id = 1;
		test.name = "Talking"
		otherTalking[test.id] = true;
		//otherPlayers.push(myPlayer, test, myPlayer, myPlayer, test, myPlayer, test, myPlayer, test);
		otherPlayers.push(myPlayer, test);
		otherTalking[myPlayer.id] = false;
		//otherPlayers.push(myPlayer);
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
			<div className="otherplayers-container">
				<div className="otherplayers">
					{
						talking && myPlayer &&
						<Avatar key={myPlayer.id} player={myPlayer}
									talking={true}
									borderColor={'#2ecc71'}
									isAlive={!myPlayer.isDead}
									size={40} />
					}
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
						otherPlayers/*Sorted*//*.filter((player: Player) => {
							return !otherTalking[player.id];
						})*/.map((player: Player) => {
							let connected = Object.values(socketPlayerIds).includes(player.id);
							return (
								<Avatar key={player.id} player={player}
									talking={!connected/* || otherTalking[player.id]*/}
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