import test from 'node:test'
import assert from 'node:assert/strict'
import { channelScopeCovers, reachesChannel } from '../src/types/channels.ts'

test('a cue for specific groups never acts on another group', () => {
  assert.equal(channelScopeCovers(['channel_1'], ['channel_1']), true)
  assert.equal(channelScopeCovers(['channel_1'], ['channel_2']), false)
  assert.equal(channelScopeCovers(['channel_1'], ['channel_3', 'channel_2']), false)
})

test('a grouped cue leaves cues that also run outside its groups alone', () => {
  assert.equal(channelScopeCovers(['channel_1'], ['all']), false)
  assert.equal(channelScopeCovers(['channel_1'], []), false)
  assert.equal(channelScopeCovers(['channel_1'], undefined), false)
  assert.equal(channelScopeCovers(['channel_1'], ['channel_1', 'channel_2']), false)
  assert.equal(channelScopeCovers(['channel_1', 'channel_2'], ['channel_2']), true)
})

test('only a cue for everybody acts across groups', () => {
  for (const all of [['all'], [], undefined, ['channel_all'], ['channel_1', 'all']]) {
    assert.equal(channelScopeCovers(all, ['channel_2']), true)
    assert.equal(channelScopeCovers(all, ['all']), true)
  }
})

test('a device only receives cues for its own group', () => {
  assert.equal(reachesChannel(['channel_1'], 'channel_2'), false)
  assert.equal(reachesChannel(['channel_1'], 'channel_1'), true)
  assert.equal(reachesChannel(['all'], 'channel_2'), true)
  assert.equal(reachesChannel(['channel_1'], null), true)
})
