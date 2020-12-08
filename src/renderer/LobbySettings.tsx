import { ipcRenderer } from 'electron';
import React, { useContext } from "react";
import { LobbySettingsContext } from "./App";
import './css/settings.css';

export interface ILobbySettingsProps {
	open: boolean;
	/*onClose: any;*/
	readOnly: boolean;
}

export interface ILobbySettings {
	[setting: string]: any;
}

export enum VoiceDistanceModel {
	Linear, Exponential
}

export default function LobbySettings({ open/*, onClose*/, readOnly }: ILobbySettingsProps) {
	const [lobbySettings] = useContext(LobbySettingsContext);

	if (!lobbySettings) return null;

	function updateSetting(setting: string, value: any) {
		if (readOnly) return false;

		//socket.emit('setLobbySetting', setting, value);

		ipcRenderer.emit('lobbySettingUpdate', setting, value);

		return true;
	}

	return <div id="lobby-settings" style={{ transform: open ? 'translateX(0)' : 'translateX(200%)' }}>
		{/*<div className="titlebar">
			<span className="title">Lobby Settings</span>
			<svg className="titlebar-button back" viewBox="0 0 24 24" fill="#868686" width="20px" height="20px" onClick={() => onClose()}>
				<path d="M0 0h24v24H0z" fill="none" />
				<path d="M11.67 3.87L9.9 2.1 0 12l9.9 9.9 1.77-1.77L3.54 12z" />
			</svg>
		</div>*/}

		{ readOnly &&
		<div className="form-control m" style={{ color: '#ff0000' }}><label id="read-only">Read-only</label></div>
		}

		<div className="settings-scroll">
			<div className="form-control m" style={{ color: '#9b59b6' }} onClick={() => updateSetting('impostorVentChat', !lobbySettings.impostorVentChat)}>
				<input type="checkbox" checked={lobbySettings.impostorVentChat} style={{ color: '#9b59b6' }} readOnly /*disabled={readOnly}*//>
				<label>Impostor chat in vent</label>
			</div>
			<div className="form-control m" style={{ color: '#9b59b6' }} onClick={() => updateSetting('commsSabotageVoice', !lobbySettings.commsSabotageVoice)}>
				<input type="checkbox" checked={lobbySettings.commsSabotageVoice} style={{ color: '#9b59b6' }} readOnly /*disabled={readOnly}*//>
				<label>Comms sabotage disables voice</label>
			</div>
			<hr/>
			<div className="form-control m" style={{ color: '#9b59b6' }}>
				<label>Voice distance model:</label>
				<div className="form-control m" style={{ color: '#9b59b6' }} onClick={() => updateSetting('voiceDistanceModel', VoiceDistanceModel.Linear)}>
					<input type="radio" checked={lobbySettings.voiceDistanceModel == VoiceDistanceModel.Linear} style={{ color: '#9b59b6' }} readOnly/>
					<label>Linear</label>
				</div>
				<div className="form-control m" style={{ color: '#9b59b6' }} onClick={() => updateSetting('voiceDistanceModel', VoiceDistanceModel.Exponential)}>
					<input type="radio" checked={lobbySettings.voiceDistanceModel == VoiceDistanceModel.Exponential} style={{ color: '#9b59b6' }} readOnly/>
					<label>Exponential</label>
				</div>
			</div>
			{
				lobbySettings.voiceDistanceModel == VoiceDistanceModel.Exponential &&
			<div className="form-control m" style={{ color: '#9b59b6' }}>
				<label>Exponential voice gain: {Math.round(lobbySettings.exponentialGain * 100)}%</label>
				<br/>
				<input spellCheck={false} type="range" min="0.1" max="2" step="0.01" list="radiusSettings" onChange={(ev) => updateSetting('exponentialGain', /[0-9]+([\.,][0-9]+)?/.test(ev.target.value) ? parseFloat(ev.target.value) : 0.8)} value={lobbySettings.exponentialGain}/>
				<datalist id="radiusSettings">
					<option>0.8</option>
					<option>1</option>
				</datalist>
			</div>
			}
			<div className="form-control m" style={{ color: '#9b59b6' }}>
				<label>Voice model radius: {Math.round(lobbySettings.voiceRadius / 5.32 * 100)}% ({lobbySettings.voiceRadius})</label>
				<br/>
				<input spellCheck={false} type="range" min="0.5" max="10" step="0.01" list="radiusSettings" onChange={(ev) => updateSetting('voiceRadius', /[0-9]+([\.,][0-9]+)?/.test(ev.target.value) ? parseFloat(ev.target.value) : /*2.4*/5.32)} value={lobbySettings.voiceRadius}/>
				<datalist id="radiusSettings">
					<option>2.4</option>
					<option>2.66</option>
					<option>5.32</option>
				</datalist>
			</div>
			<div className="form-control m" style={{ color: '#9b59b6' }}>
				<label>Max hearing range: {Math.round(lobbySettings.voiceMaxDistance / /*6*/3.75 * 100)}% ({lobbySettings.voiceMaxDistance})</label>
				<br/>
				<input spellCheck={false} type="range" min="1" max="10" step="0.01" list="distanceSettings" onChange={(ev) => updateSetting('voiceMaxDistance', /[0-9]+([\.,][0-9]+)?/.test(ev.target.value) ? parseFloat(ev.target.value) : /*6*/3.75)} value={lobbySettings.voiceMaxDistance}/>
				<datalist id="distanceSettings">
					<option>3.75</option>
					<option>6</option>
					<option>7</option>
				</datalist>
			</div>
			<div className="form-control m" style={{ color: '#9b59b6' }}>
				<label>Window obstructed volume: {Math.round(lobbySettings.windowObstructedVolume * 100)}%</label>
				<br/>
				<input spellCheck={false} type="range" min="0" max="1" step="0.01" list="windowVolSettings" onChange={(ev) => updateSetting('windowObstructedVolume', /[0-9]+([\.,][0-9]+)?/.test(ev.target.value) ? parseFloat(ev.target.value) : 0)} value={lobbySettings.windowObstructedVolume}/>
				<datalist id="windowVolSettings">
					<option>0.1</option>
					<option>0.2</option>
					<option>0.5</option>
				</datalist>
				<input type="checkbox" checked={lobbySettings.windowObstructedMuffle} style={{ color: '#9b59b6' }} onClick={() => updateSetting('windowObstructedMuffle', !lobbySettings.windowObstructedMuffle)} readOnly/>
				<label>Muffle window</label>
			</div>
			<div className="form-control m" style={{ color: '#9b59b6' }}>
				<label>Wall/door obstructed volume: {Math.round(lobbySettings.wallObstructedVolume * 100)}%</label>
				<br/>
				<input spellCheck={false} type="range" min="0" max="1" step="0.01" list="wallVolSettings" onChange={(ev) => updateSetting('wallObstructedVolume', /[0-9]+([\.,][0-9]+)?/.test(ev.target.value) ? parseFloat(ev.target.value) : 0)} value={lobbySettings.wallObstructedVolume}/>
				<datalist id="wallVolSettings">
					<option>0.1</option>
					<option>0.2</option>
					<option>0.5</option>
				</datalist>
				<input type="checkbox" checked={lobbySettings.wallObstructedMuffle} style={{ color: '#9b59b6' }} onClick={() => updateSetting('wallObstructedMuffle', !lobbySettings.wallObstructedMuffle)} readOnly/>
				<label>Muffle wall/door</label>
			</div>
		</div>
	</div>
}