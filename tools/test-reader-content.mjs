import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContent } from '../src/reader.js';

test('game is recognized without user configuration and excludes surrounding text', () => {
    assert.equal(extractContent('<thinking>思考</thinking>\n<game>正文内容</game>\n<status>状态</status>'), '正文内容');
    assert.equal(extractContent('<GAME mode="story">\n大小写与属性\n</GAME >'), '大小写与属性');
});

test('game takes precedence over other default and custom body tags', () => {
    assert.equal(extractContent('<content>其他</content><novel>自定义</novel><game>实际正文</game>', ['novel']), '实际正文');
});

test('partial tag names and incomplete game tags retain existing fallback behavior', () => {
    assert.equal(extractContent('<gameplay>其他</gameplay><content>正文</content>'), '正文');
    assert.equal(extractContent('<game>未结束<novel>自定义正文</novel>', ['novel']), '自定义正文');
    assert.equal(extractContent('普通无标签正文'), '普通无标签正文');
});
