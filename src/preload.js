'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('app:status'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  getMeeting: (id) => ipcRenderer.invoke('meetings:get', id),
  createMeeting: () => ipcRenderer.invoke('meetings:create'),
  updateMeeting: (id, patch) => ipcRenderer.invoke('meetings:update', id, patch),
  deleteMeeting: (id) => ipcRenderer.invoke('meetings:delete', id),

  startRecording: (id) => ipcRenderer.invoke('rec:start', id),
  sendAudio: (source, samples) => ipcRenderer.send('rec:audio', source, samples),
  stopRecording: (id, audio, seconds, tracks) => ipcRenderer.invoke('rec:stop', id, audio, seconds, tracks),
  onSegment: on('rec:segment'),
  onRecordingError: on('rec:error'),

  meetingAudio: (id, name) => ipcRenderer.invoke('refine:audio', id, name),
  importAudio: (id, phase, samples, opts) => ipcRenderer.invoke('refine:import', id, phase, samples, opts),
  refine: (id) => ipcRenderer.invoke('refine:run', id),
  onRefineProgress: on('refine:progress'),

  renameSpeaker: (id, speakerId, name) => ipcRenderer.invoke('speakers:rename', id, speakerId, name),
  assignLines: (id, segmentIds, name) => ipcRenderer.invoke('segments:assign', id, segmentIds, name),
  editLines: (id, segmentIds, text) => ipcRenderer.invoke('segments:edit', id, segmentIds, text),
  learningSummary: () => ipcRenderer.invoke('learning:summary'),
  learningForget: (kind, key) => ipcRenderer.invoke('learning:forget', kind, key),
  listVoices: () => ipcRenderer.invoke('voices:list'),
  deleteVoice: (name) => ipcRenderer.invoke('voices:delete', name),

  generateNotes: (id) => ipcRenderer.invoke('notes:generate', id),
  onNotesChunk: on('notes:chunk'),
});
