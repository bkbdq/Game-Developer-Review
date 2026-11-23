import assert from 'node:assert/strict';
import test from 'node:test';
import { projectStats, compareProjects, isRecentPick } from '../src/lib/project-stats.ts';

const asOf='2026-11-20';
const review=(score,publishedAt=asOf)=>({score,publishedAt});
test('近期好评榜同时检查平均分、总好评率和窗口内好评',()=>{
  const eligible = { meanScore:4, positive:7, negative:3, recentPositive:1 };
  assert.ok(isRecentPick(eligible));
  assert.equal(isRecentPick({ ...eligible, positive:69, negative:31, recentPositive:69 }),false);
  assert.equal(isRecentPick({ ...eligible, recentPositive:0 }),false);
  assert.equal(isRecentPick({ ...eligible, meanScore:3.99 }),false);
  assert.equal(isRecentPick(projectStats([4,4,4,1].map(s=>review(s)),asOf)),false);
  assert.equal(isRecentPick(projectStats([],asOf)),false);
  assert.ok(isRecentPick(projectStats([review(4)],asOf)));
});
test('近30个自然日包含今天和首日，仅4或5星计为好评',()=>{
  const stats=projectStats([review(5,'2026-10-21'),review(4,'2026-10-22'),review(5),review(3),review(4,'2026-11-21')],asOf);
  assert.equal(stats.recentPositive,2);
  assert.equal(stats.count,5);
});
test('小样本不评级，20 篇和 50 篇启用更高等级',()=>{
  for (const [count,score,grade,ratio] of [
    [0,5,'暂无评价',null], [1,5,'评分过少',null], [4,2,'评分过少',null],
    [5,4,'好评',1], [19,4,'好评',1], [20,4,'特别好评',1], [49,4,'特别好评',1],
    [50,4,'好评如潮',1], [5,2,'差评',0], [20,2,'特别差评',0]
  ]) {
    const rating = projectStats(Array.from({length:count},()=>review(score)),asOf);
    assert.equal(rating.grade, grade);
    assert.equal(rating.ratio, ratio);
    assert.equal(rating.rated, count>=5);
  }
});
test('中评计入样本和分布，但不参加好评率；全中评没有数值好评率',()=>{
  const mixed=projectStats([5,5,4,3,2].map(s=>review(s)),asOf);
  assert.deepEqual([mixed.positive,mixed.neutral,mixed.negative,mixed.ratio,mixed.grade],[3,1,1,.75,'多半好评']);
  const allNeutral=projectStats(Array.from({length:5},()=>review(3)),asOf);
  assert.deepEqual([allNeutral.count,allNeutral.grade,allNeutral.ratio,allNeutral.tone],[5,'褒贬不一',null,'neutral']);
  for (const [positives,grade] of [[0,'特别差评'],[20,'多半差评'],[40,'褒贬不一'],[70,'多半好评'],[80,'特别好评'],[95,'好评如潮']]) {
    const scores = Array.from({length:100},(_,i)=>review(i<positives?5:1));
    assert.equal(projectStats(scores,asOf).grade,grade);
  }
});
test('近期好评数优先，历史好评仅用于同数项目的排序',()=>{
  const old=review(5,'2026-10-01');
  const item=(name,reviews)=>({name,path:name,...projectStats(reviews,asOf)});
  const list=[item('历史多',[old,old,old]),item('近期一',[review(4)]),item('近期一且历史多',[review(4),old]),item('近期二',[review(4),review(5)])];
  assert.deepEqual(list.sort(compareProjects).map(p=>p.name),['近期二','近期一且历史多','近期一','历史多']);
});
