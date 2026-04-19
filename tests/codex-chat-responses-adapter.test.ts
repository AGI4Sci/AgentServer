import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChatCompletionsRequest,
  buildSyntheticResponsesFromChatCompletion,
} from '../server/runtime-supervisor/codex-chat-responses-adapter.ts';

test('codex responses bridge maps developer role to system for chat completions', () => {
  const prepared = buildChatCompletionsRequest({
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'follow project rules' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
    model: 'glm-5.1',
  });

  assert.equal(prepared.chatRequest.messages[0].role, 'system');
  assert.equal(prepared.chatRequest.messages[0].content, 'follow project rules');
  assert.equal(prepared.chatRequest.messages[1].role, 'user');
});

test('codex responses bridge emits assistant text on delta path only', () => {
  const prepared = buildChatCompletionsRequest({
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    model: 'glm-5.1',
  });
  const synthetic = buildSyntheticResponsesFromChatCompletion(
    { model: 'glm-5.1' },
    prepared,
    {
      model: 'glm-5.1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'connected',
          },
        },
      ],
    },
  );

  const delta = synthetic.events.find((event) => event.event === 'response.output_text.delta');
  const done = synthetic.events.find((event) => event.event === 'response.output_item.done');
  assert.equal(delta?.data.delta, 'connected');
  assert.deepEqual(done?.data.item.content, []);
  assert.equal(synthetic.storedConversation.messages.at(-1)?.content, 'connected');
});
