import { describe, it, expect } from 'vitest';
import { ConversationStore } from './conversation.store';
describe('ConversationStore', () => {
  it('adds timestamped player messages', () => {
    const store = new ConversationStore();
    store.player('Bonjour');
    expect(store.value[0]).toMatchObject({
      speaker: 'player',
      text: 'Bonjour',
      timestamp: expect.any(Date),
    });
  });
  it('creates and concatenates one streaming reply then replaces it with final text', () => {
    const store = new ConversationStore();
    store.reply('Guide', 'Pre', false);
    const id = store.value[0].id;
    store.reply('Guide', 'nez place', false);
    expect(store.value).toHaveLength(1);
    expect(store.value[0].text).toBe('Prenez place');
    expect(store.value[0].streaming).toBe(true);
    store.reply('Guide', 'Prenez place !', true);
    expect(store.value[0]).toMatchObject({ id, text: 'Prenez place !', streaming: false });
    store.reply('Guide', 'Autre réponse', true);
    expect(store.value).toHaveLength(2);
  });
  it('keeps different speakers and interrupted turns separate', () => {
    const store = new ConversationStore();
    store.reply('A', 'A', false);
    store.interrupt();
    store.reply('A', 'B', false);
    expect(store.value).toHaveLength(2);
    store.reply('B', 'C', true);
    expect(store.value).toHaveLength(3);
  });
  it('deduplicates only the pending optimistic echo', () => {
    const store = new ConversationStore();
    store.player('Oui', true);
    store.player('Oui');
    store.reply('A', 'D’accord', true);
    store.player('Oui');
    expect(store.value.filter((message) => message.speaker === 'player')).toHaveLength(2);
  });
});
