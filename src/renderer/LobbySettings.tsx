import React from "react";
import { Socket } from 'socket.io-client';
import './css/settings.css';

export interface ILobbySettingsProps {
	socket: typeof Socket;
	lobbySettings: ILobbySettings;
}

export interface ILobbySettings {
	[socketId: string]: any;
}

export default function LobbySettings({ socket, lobbySettings }: ILobbySettingsProps) {
	if (!socket) return null;

	return (
		<div className="lobby-settings">
			<div className="settings-scroll">
				<div className="form-control m" style={{ color: '#9b59b6' }} onClick={() => { 
					socket.emit('setLobbySetting', 'impostorVentChat', !lobbySettings.impostorVentChat);
				}}>
					<input type="checkbox" checked={lobbySettings.impostorVentChat ?? true} style={{ color: '#9b59b6' }} readOnly />
					<label>Impostor chat in vent</label>
				</div>
			</div>
		</div>
	);
}