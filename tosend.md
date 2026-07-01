1）state_v2_render字段是否有点多余？感觉每次读取时实时在代码里面拼render是不是更灵活，想改一些连接词直接修改代码即可，不用再回填数据库了。
2）我同意列名叫 memory_state更合适。
3）milestones放到core里是不是更合适？
4） meta: {
perSectionCursor: {},
sectionVersions: {},
promptVersions: {}
}
这部分的作用？
5）各个字段，像是userProfile、recentEpisodes，是不是有必要先在文档里规定更详细的结构或者模板？
6）proposer是不是应当有多个，每个字段（如todos、scene）分别有一个，因为它们更新的时机一般不相同。
