import path from 'node:path';
import { unique } from './common.mjs';

const stopWords = new Set([
  'the','and','for','with','from','into','that','this','then','than','when','where','what','how','why','who',
  'implement','create','update','fix','add','remove','change','make','build','refactor','please','need','needs',
  'can','could','should','would','will','shall','done','task','feature','bug','issue','error','test','code',
  '一个','这个','那个','需要','实现','修改','修复','新增','删除','更新','功能','问题','代码','项目','里面','可以','帮我','我们'
]);

const zhTermMap = [
  ['多智能体故事生成系统', ['multiple_agent_for_stories', 'multi_agent', 'story_generator', 'story_workbench']],
  ['多智能体', ['multi_agent', 'agent_runtime', 'orchestration']],
  ['智能体', ['agent', 'agent_runtime']],
  ['故事工作台', ['story_workbench', 'product_workbench']],
  ['产品工作台', ['product_workbench', 'story_workbench']],
  ['工作台', ['workbench', 'frontend', 'ui']],
  ['故事分析器', ['analyze_stories', 'story_analyzer', 'analysis_report']],
  ['故事分析', ['analyze_stories', 'story_analysis', 'analysis_report']],
  ['故事设定交接', ['story_setup_handoff', 'story_setup', 'premise']],
  ['故事设定', ['story_setup', 'premise', 'world_canvas']],
  ['故事前提', ['story_premise', 'premise']],
  ['故事构思', ['story_idea', 'premise']],
  ['故事方向', ['story_direction', 'premise']],
  ['故事生成', ['story_generation', 'scene_generation', 'writer_agent']],
  ['故事正文', ['prose', 'writer_agent', 'scene_text']],
  ['故事', ['story', 'story_project']],
  ['项目思维框架', ['project_thinking_framework', 'knowledge_base']],
  ['思维框架', ['thinking_framework', 'knowledge_base']],
  ['知识库', ['knowledge_base', 'documentation']],
  ['正文引擎', ['writer_agent', 'prose_engine', 'scene_text']],
  ['正文', ['prose', 'scene_text', 'writer_agent']],
  ['写作引擎', ['writer_agent', 'prose_engine']],
  ['写作', ['writer_agent', 'prose', 'scene_writing']],

  ['世界画布', ['world_canvas', 'world', 'story_fact_base']],
  ['世界事实', ['world_fact', 'world_canvas', 'fact_base']],
  ['事实库', ['fact_base', 'world_canvas', 'canon']],
  ['世界规则', ['world_rule', 'world_canvas', 'canon']],
  ['世界结构', ['world_structure', 'world_canvas']],
  ['世界', ['world', 'world_canvas']],
  ['画布', ['canvas', 'world_canvas']],
  ['地理', ['geography', 'location', 'world_canvas']],
  ['地点', ['location', 'world_canvas']],
  ['阵营', ['faction', 'world_canvas']],
  ['文化', ['culture', 'world_canvas']],
  ['历史', ['history', 'world_canvas']],
  ['确认世界画布', ['confirm_world_canvas', 'world_canvas']],

  ['角色生成提示吸收', ['role_generation_prompt_absorption', 'character_generation_prompt', 'character_service']],
  ['角色生成提示', ['character_generation_prompt', 'role_generation_prompt']],
  ['角色生成', ['character_generation', 'character_service']],
  ['角色状态', ['character_state', 'state_change', 'character']],
  ['角色心理', ['character_psychology', 'character_state']],
  ['角色档案', ['character_profile', 'character']],
  ['角色关系', ['relationship', 'character_relationship']],
  ['主角', ['main_character', 'character']],
  ['配角', ['supporting_character', 'character']],
  ['支援角色', ['supporting_role', 'supporting_character']],
  ['角色', ['character', 'character_service']],
  ['当前欲望', ['current_desire', 'character_state']],
  ['当前恐惧', ['current_fear', 'character_state']],
  ['行动意图', ['active_goal', 'character_state']],
  ['底线', ['bottom_line', 'character_state']],
  ['禁忌知识', ['forbidden_knowledge', 'character_state']],
  ['知识范围', ['knowledge_scope', 'character_state']],
  ['关系草稿', ['relationship_draft', 'relationship']],
  ['关系状态', ['relationship_state', 'relationship']],
  ['关系', ['relationship', 'character_relationship']],

  ['长期记忆', ['long_term_memory', 'memory_record', 'memory']],
  ['结构化记忆', ['memory_record', 'structured_memory', 'memory']],
  ['记忆检索', ['memory_retrieval', 'memory_pack', 'memory']],
  ['记忆包', ['memory_pack', 'memory_retrieval']],
  ['记忆记录', ['memory_record', 'memory']],
  ['记忆与连续性', ['memory', 'continuity']],
  ['记忆连续性', ['memory', 'continuity']],
  ['记忆', ['memory', 'memory_record', 'memory_pack']],
  ['状态变化', ['state_change', 'character_state']],
  ['状态变更', ['state_change', 'character_state']],
  ['事件摘要', ['event_summary', 'event']],
  ['事件记录', ['event', 'event_summary']],
  ['事件', ['event', 'story_event']],

  ['章节框架审核', ['chapter_framework_audit', 'chapter_framework', 'validation']],
  ['章节框架', ['chapter_framework', 'framework_package', 'chapter_plan']],
  ['章节计划', ['chapter_plan', 'chapter_planning']],
  ['章节规划', ['chapter_plan', 'chapter_planning']],
  ['章节归档', ['chapter_archive', 'chapter_completion']],
  ['章节存档', ['chapter_archive', 'chapter_completion']],
  ['章节推进', ['chapter_progress', 'chapter_plan']],
  ['下一章', ['next_chapter', 'chapter_progress']],
  ['当前章', ['current_chapter', 'chapter_progress']],
  ['多章节', ['multi_chapter', 'chapter_plan']],
  ['章节', ['chapter', 'chapter_plan']],
  ['里程碑', ['milestone', 'phase']],

  ['当前章节框架', ['current_chapter_framework', 'chapter_framework']],
  ['动态章节框架', ['dynamic_chapter_framework', 'chapter_framework_builder']],
  ['即时章节框架', ['jit_chapter_framework', 'chapter_framework_builder']],
  ['章节框架构建', ['chapter_framework_builder', 'chapter_framework']],
  ['框架构建', ['framework_builder', 'chapter_framework_builder']],
  ['框架工作台', ['framework_workbench', 'framework_package']],
  ['框架包', ['framework_package', 'framework']],
  ['框架模块库', ['framework_module_library', 'framework_package']],
  ['模块库', ['module_library', 'framework_module_library']],
  ['宏观组件', ['macro_component', 'framework_package']],
  ['大框架', ['macro_framework', 'framework_package']],
  ['故事框架', ['story_framework', 'framework_package']],
  ['框架', ['framework', 'framework_package']],

  ['场景生成摘要', ['scene_generation_summary', 'scene_generation']],
  ['场景生成', ['scene_generation', 'scene_service']],
  ['场景写作', ['scene_writing', 'writer_agent', 'scene']],
  ['场景规划', ['scene_plan', 'scene_beat']],
  ['场景节拍', ['scene_beat', 'chapter_scene_beat']],
  ['场景模式相似度', ['scene_pattern_similarity', 'scene_pattern_gate']],
  ['场景模式', ['scene_pattern', 'scene_pattern_gate']],
  ['相似度门', ['similarity_gate', 'scene_pattern_gate']],
  ['场景门', ['scene_gate', 'quality_gate', 'continuity_gate']],
  ['场景修订', ['scene_revision', 'scene_revision_candidate']],
  ['修订候选', ['scene_revision_candidate', 'scene_revision']],
  ['正式应用', ['formal_apply', 'scene_revision']],
  ['临时场景', ['provisional_scene', 'scene']],
  ['场景数量', ['scene_count', 'scene_plan']],
  ['场景索引', ['scene_index', 'scene']],
  ['场景', ['scene', 'scene_generation']],
  ['幕', ['scene', 'act']],

  ['质量门', ['quality_gate', 'quality_report']],
  ['质量门禁', ['quality_gate', 'quality_report']],
  ['质量检查', ['quality_check', 'quality_gate']],
  ['质量报告', ['quality_report', 'quality_gate']],
  ['质量状态', ['quality_status', 'quality_gate']],
  ['连续性门', ['continuity_gate', 'continuity']],
  ['连续性检查', ['continuity_check', 'continuity']],
  ['连续性缺口', ['continuity_gap', 'continuity']],
  ['连续性断点', ['continuity_issue', 'continuity']],
  ['连续性', ['continuity', 'memory']],
  ['语义检查', ['semantic_check', 'validation']],
  ['验证门', ['validation_gate', 'validation']],
  ['验证', ['validation', 'quality_gate']],
  ['阻塞', ['blocking_issue', 'validation']],
  ['质量', ['quality', 'quality_gate']],

  ['后台思考', ['background_thinking', 'thinking_state', 'agent_runtime']],
  ['后台返工', ['background_repair', 'repair_loop', 'scene_gate_repair']],
  ['自动返工', ['auto_repair', 'repair_loop']],
  ['有界返工', ['bounded_repair', 'repair_loop']],
  ['返工', ['repair', 'repair_loop']],
  ['运行时证据', ['runtime_evidence', 'evidence']],
  ['运行时降级', ['runtime_degraded', 'provider_health', 'model_gateway']],
  ['运行时', ['runtime', 'agent_runtime']],
  ['可观测性', ['observability', 'tracing', 'provider_health']],
  ['追踪', ['tracing', 'langsmith', 'observability']],
  ['模型网关', ['model_gateway', 'provider', 'model_provider']],
  ['模型设置', ['model_settings', 'model_gateway']],
  ['模型提供商', ['model_provider', 'provider', 'model_gateway']],
  ['提供商', ['provider', 'model_provider']],
  ['模型', ['model', 'model_gateway']],
  ['健康检查', ['provider_health', 'runtime_health']],
  ['降级', ['degraded', 'provider_health']],
  ['密钥', ['api_key', 'model_provider']],

  ['叙事意图', ['authorial_intent', 'narrative_intent']],
  ['作者意图', ['authorial_intent', 'narrative_intent']],
  ['表面矛盾', ['apparent_contradiction', 'narrative_debt']],
  ['叙事债务', ['narrative_debt', 'payoff_tracker']],
  ['伏笔回收', ['foreshadowing', 'payoff_tracker']],
  ['伏笔', ['foreshadowing', 'narrative_debt']],
  ['回收', ['payoff', 'payoff_tracker']],
  ['开放式留白', ['open_ambiguity', 'narrative_debt']],
  ['留白', ['open_ambiguity', 'narrative_debt']],
  ['误导', ['misdirection', 'narrative_debt']],
  ['谎言', ['lie', 'narrative_debt']],
  ['幻觉', ['hallucination', 'narrative_debt']],
  ['主观事实', ['subjective_fact', 'subjective_reality']],
  ['客观事实', ['objective_fact', 'canon']],
  ['感知现实', ['perceived_reality', 'subjective_fact']],
  ['叙事层', ['narrative_layer', 'narrative_debt']],
  ['悬念', ['suspense', 'narrative_debt']],

  ['交接包', ['handoff_bundle', 'import_package']],
  ['生成器交接', ['generator_handoff', 'handoff_bundle']],
  ['分析报告', ['analysis_report', 'story_analysis_report']],
  ['全书包', ['full_book_bundle', 'import_package']],
  ['导入框架', ['imported_framework', 'framework_package']],
  ['导入门', ['import_gate', 'validation']],
  ['推荐治理', ['recommendation_governance', 'governance']],
  ['传播治理', ['propagation_governance', 'governance']],
  ['治理', ['governance']],

  ['项目入口', ['project_entry', 'project_workbench']],
  ['项目列表', ['project_list', 'project']],
  ['创建项目', ['create_project', 'project']],
  ['当前项目', ['current_project', 'project']],
  ['项目创建', ['project_creation', 'project']],
  ['未命名故事', ['untitled_story_project', 'project']],
  ['源项目', ['source_project', 'project']],

  ['最终输出', ['final_story_package', 'export']],
  ['最终故事包', ['final_story_package', 'export']],
  ['插件输出', ['plugin_output', 'plugin_artifact']],
  ['插件', ['plugin', 'plugin_artifact']],
  ['资产包', ['asset_bundle', 'export']],
  ['剧本锻造', ['script_forging', 'final_story_package']],
  ['分镜', ['storyboard', 'script_forging']],
  ['导出', ['export', 'final_story_package']],

  ['存储基础', ['storage_foundation', 'database', 'postgres']],
  ['运行数据', ['runtime_data', 'local_project', 'storage']],
  ['本地项目', ['local_project', 'runtime_data']],
  ['本地运行数据', ['local_project', 'runtime_data']],
  ['Harness引擎', ['harness', 'task_parser', 'impact_analysis']],
  ['Harness', ['harness', 'task_parser', 'impact_analysis']],
  ['语义检索', ['semantic_search', 'pgvector', 'memory_retrieval']],
  ['向量', ['vector', 'pgvector']],
  ['迁移脚本', ['migration', 'database']],
  ['仓储', ['repository', 'storage']],
  ['数据访问层', ['repository', 'storage']],

  ['提示吸收', ['prompt_absorption', 'prompt_fidelity']],
  ['提示保真', ['prompt_fidelity', 'prompt_absorption']],
  ['提示词', ['prompt', 'prompt_fidelity']],
  ['生成契约', ['generator_contract', 'analyzer_generator_contract']],
  ['分析器到生成器', ['analyzer_generator_contract', 'handoff_bundle']],
  ['安全摘录', ['safe_excerpt', 'chapter_archive']],
  ['摘要', ['summary', 'event_summary']],

  ['退款', ['refund', 'payment', 'order']],
  ['订单', ['order', 'checkout']],
  ['支付', ['payment', 'billing', 'ledger']],
  ['账单', ['billing', 'invoice']],
  ['余额', ['balance', 'ledger']],
  ['结算', ['settlement', 'ledger']],
  ['登录', ['login', 'auth', 'session']],
  ['注册', ['signup', 'register', 'user']],
  ['权限', ['permission', 'authorization', 'rbac', 'auth']],
  ['认证', ['auth', 'authentication', 'session']],
  ['接口', ['api', 'route', 'controller', 'schema']],
  ['数据库', ['database', 'db', 'schema', 'migration', 'model']],
  ['迁移', ['migration', 'schema', 'database']],
  ['前端', ['frontend', 'client', 'ui', 'component']],
  ['后端', ['backend', 'server', 'service']],
  ['页面', ['page', 'view', 'component', 'route']],
  ['组件', ['component', 'ui']],
  ['测试', ['test', 'spec']],
  ['合同', ['contract', 'schema']],
  ['类型', ['type', 'types', 'interface']],
  ['配置', ['config', 'configuration']],
  ['构建', ['build', 'ci']],
  ['部署', ['deploy', 'deployment', 'ci']],
  ['缓存', ['cache']],
  ['搜索', ['search']],
  ['通知', ['notification', 'email', 'sms']],
  ['订阅', ['subscription', 'billing']],
  ['用户', ['user', 'account', 'profile']],
  ['管理后台', ['admin', 'dashboard']],
  ['后端', ['backend', 'server', 'service']],
  ['后台', ['background', 'backend', 'server']],
  ['前台', ['frontend', 'client', 'ui']]
];

const enTermMap = [
  ['multiple agent for stories', ['multiple_agent_for_stories', 'multi_agent', 'story_generator', 'story_workbench']],
  ['multi agent', ['multi_agent', 'agent_runtime', 'orchestration']],
  ['story workbench', ['story_workbench', 'product_workbench']],
  ['product workbench', ['product_workbench', 'story_workbench']],
  ['analyze stories', ['analyze_stories', 'story_analyzer', 'analysis_report', 'framework_mining']],
  ['story analyzer', ['story_analyzer', 'analyze_stories']],
  ['story setup handoff', ['story_setup_handoff', 'story_setup', 'premise']],
  ['story setup', ['story_setup', 'premise']],
  ['story premise', ['story_premise', 'premise']],
  ['story idea', ['story_idea', 'premise']],
  ['story direction', ['story_direction', 'premise']],
  ['story generation', ['story_generation', 'scene_generation', 'writer_agent']],
  ['world canvas', ['world_canvas', 'world', 'story_fact_base']],
  ['world fact', ['world_fact', 'world_canvas', 'fact_base']],
  ['fact base', ['fact_base', 'world_canvas', 'canon']],
  ['world rule', ['world_rule', 'world_canvas', 'canon']],
  ['world structure', ['world_structure', 'world_canvas']],
  ['confirm world canvas', ['confirm_world_canvas', 'world_canvas']],

  ['role generation prompt absorption', ['role_generation_prompt_absorption', 'character_generation_prompt', 'character_service']],
  ['character generation prompt', ['character_generation_prompt', 'role_generation_prompt']],
  ['role generation prompt', ['role_generation_prompt', 'character_generation_prompt']],
  ['character generation', ['character_generation', 'character_service']],
  ['character state', ['character_state', 'state_change', 'character']],
  ['character profile', ['character_profile', 'character']],
  ['supporting role', ['supporting_role', 'supporting_character']],
  ['supporting character', ['supporting_character', 'character']],
  ['main character', ['main_character', 'character']],
  ['current desire', ['current_desire', 'character_state']],
  ['current fear', ['current_fear', 'character_state']],
  ['active goal', ['active_goal', 'character_state']],
  ['bottom line', ['bottom_line', 'character_state']],
  ['forbidden knowledge', ['forbidden_knowledge', 'character_state']],
  ['knowledge scope', ['knowledge_scope', 'character_state']],
  ['relationship draft', ['relationship_draft', 'relationship']],
  ['relationship state', ['relationship_state', 'relationship']],

  ['long term memory', ['long_term_memory', 'memory_record', 'memory']],
  ['structured memory', ['memory_record', 'structured_memory', 'memory']],
  ['memory retrieval', ['memory_retrieval', 'memory_pack', 'memory']],
  ['memory pack', ['memory_pack', 'memory_retrieval']],
  ['memory record', ['memory_record', 'memory']],
  ['state change', ['state_change', 'character_state']],
  ['event summary', ['event_summary', 'event']],

  ['chapter framework audit', ['chapter_framework_audit', 'chapter_framework', 'validation']],
  ['current chapter framework', ['current_chapter_framework', 'chapter_framework']],
  ['dynamic chapter framework', ['dynamic_chapter_framework', 'chapter_framework_builder']],
  ['jit chapter framework', ['jit_chapter_framework', 'chapter_framework_builder']],
  ['chapter framework builder', ['chapter_framework_builder', 'chapter_framework']],
  ['chapter framework', ['chapter_framework', 'framework_package', 'chapter_plan']],
  ['chapter plan', ['chapter_plan', 'chapter_planning']],
  ['chapter planning', ['chapter_plan', 'chapter_planning']],
  ['chapter archive', ['chapter_archive', 'chapter_completion']],
  ['chapter progress', ['chapter_progress', 'chapter_plan']],
  ['next chapter', ['next_chapter', 'chapter_progress']],
  ['current chapter', ['current_chapter', 'chapter_progress']],
  ['multi chapter', ['multi_chapter', 'chapter_plan']],
  ['framework package', ['framework_package', 'framework']],
  ['framework module library', ['framework_module_library', 'framework_package']],
  ['module library', ['module_library', 'framework_module_library']],
  ['macro component', ['macro_component', 'framework_package']],
  ['macro framework', ['macro_framework', 'framework_package']],
  ['story framework', ['story_framework', 'framework_package']],
  ['imported framework', ['imported_framework', 'framework_package']],

  ['scene generation summary', ['scene_generation_summary', 'scene_generation']],
  ['scene generation', ['scene_generation', 'scene_service']],
  ['scene writing', ['scene_writing', 'writer_agent', 'scene']],
  ['scene plan', ['scene_plan', 'scene_beat']],
  ['scene beat', ['scene_beat', 'chapter_scene_beat']],
  ['chapter scene beat', ['chapter_scene_beat', 'scene_beat']],
  ['scene pattern similarity', ['scene_pattern_similarity', 'scene_pattern_gate']],
  ['scene pattern gate', ['scene_pattern_gate', 'scene_pattern_similarity']],
  ['similarity gate', ['similarity_gate', 'scene_pattern_gate']],
  ['scene gate repair runtime', ['scene_gate_repair', 'repair_loop', 'quality_gate']],
  ['scene gate', ['scene_gate', 'quality_gate', 'continuity_gate']],
  ['scene revision candidate', ['scene_revision_candidate', 'scene_revision']],
  ['scene revision', ['scene_revision', 'scene_revision_candidate']],
  ['formal apply', ['formal_apply', 'scene_revision']],
  ['provisional scene', ['provisional_scene', 'scene']],
  ['scene count', ['scene_count', 'scene_plan']],
  ['scene index', ['scene_index', 'scene']],
  ['writer agent', ['writer_agent', 'prose_engine']],
  ['prose engine', ['prose_engine', 'writer_agent']],
  ['scene text', ['scene_text', 'prose']],

  ['quality gate', ['quality_gate', 'quality_report']],
  ['quality report', ['quality_report', 'quality_gate']],
  ['quality status', ['quality_status', 'quality_gate']],
  ['continuity gate', ['continuity_gate', 'continuity']],
  ['continuity check', ['continuity_check', 'continuity']],
  ['continuity gap', ['continuity_gap', 'continuity']],
  ['continuity issue', ['continuity_issue', 'continuity']],
  ['semantic check', ['semantic_check', 'validation']],
  ['validation gate', ['validation_gate', 'validation']],
  ['blocking issue', ['blocking_issue', 'validation']],

  ['background thinking', ['background_thinking', 'thinking_state', 'agent_runtime']],
  ['background repair', ['background_repair', 'repair_loop', 'scene_gate_repair']],
  ['auto repair', ['auto_repair', 'repair_loop']],
  ['bounded repair', ['bounded_repair', 'repair_loop']],
  ['runtime evidence', ['runtime_evidence', 'evidence']],
  ['runtime degraded', ['runtime_degraded', 'provider_health', 'model_gateway']],
  ['model gateway', ['model_gateway', 'provider', 'model_provider']],
  ['model settings', ['model_settings', 'model_gateway']],
  ['model provider', ['model_provider', 'provider', 'model_gateway']],
  ['provider health', ['provider_health', 'runtime_health']],
  ['langsmith', ['langsmith', 'tracing', 'observability']],
  ['api key', ['api_key', 'model_provider']],

  ['authorial intent', ['authorial_intent', 'narrative_intent']],
  ['narrative intent', ['narrative_intent', 'authorial_intent']],
  ['apparent contradiction', ['apparent_contradiction', 'narrative_debt']],
  ['narrative debt', ['narrative_debt', 'payoff_tracker']],
  ['payoff tracker', ['payoff_tracker', 'narrative_debt']],
  ['open ambiguity', ['open_ambiguity', 'narrative_debt']],
  ['subjective fact', ['subjective_fact', 'subjective_reality']],
  ['objective fact', ['objective_fact', 'canon']],
  ['perceived reality', ['perceived_reality', 'subjective_fact']],
  ['narrative layer', ['narrative_layer', 'narrative_debt']],

  ['handoff bundle', ['handoff_bundle', 'import_package']],
  ['generator handoff', ['generator_handoff', 'handoff_bundle']],
  ['analysis report', ['analysis_report', 'story_analysis_report']],
  ['story analysis report', ['story_analysis_report', 'analysis_report']],
  ['full book bundle', ['full_book_bundle', 'import_package']],
  ['import gate', ['import_gate', 'validation']],
  ['recommendation governance', ['recommendation_governance', 'governance']],
  ['propagation governance', ['propagation_governance', 'governance']],
  ['frameworkpackage', ['framework_package', 'framework']],
  ['framework package', ['framework_package', 'framework']],

  ['project entry', ['project_entry', 'project_workbench']],
  ['project list', ['project_list', 'project']],
  ['create project', ['create_project', 'project']],
  ['current project', ['current_project', 'project']],
  ['local project', ['local_project', 'runtime_data']],
  ['runtime data', ['runtime_data', 'local_project', 'storage']],
  ['final story package', ['final_story_package', 'export']],
  ['plugin artifact', ['plugin_artifact', 'plugin']],
  ['plugin output', ['plugin_output', 'plugin_artifact']],
  ['asset bundle', ['asset_bundle', 'export']],
  ['script forging', ['script_forging', 'final_story_package']],
  ['storyboard', ['storyboard', 'script_forging']],

  ['storage foundation', ['storage_foundation', 'database', 'postgres']],
  ['postgresql', ['postgres', 'database']],
  ['pgvector', ['pgvector', 'semantic_search']],
  ['semantic search', ['semantic_search', 'pgvector', 'memory_retrieval']],
  ['repository', ['repository', 'storage']],
  ['prompt absorption', ['prompt_absorption', 'prompt_fidelity']],
  ['prompt fidelity', ['prompt_fidelity', 'prompt_absorption']],
  ['generator contract', ['generator_contract', 'analyzer_generator_contract']],
  ['analyzer generator contract', ['analyzer_generator_contract', 'handoff_bundle']],
  ['safe excerpt', ['safe_excerpt', 'chapter_archive']],
  ['abcd continuity', ['abcd_continuity', 'continuity']],
  ['now modify lite', ['now_modify_lite', 'scene_revision']],
  ['harness engine', ['harness', 'task_parser', 'impact_analysis']],
  ['harness', ['harness', 'task_parser', 'impact_analysis']],
  ['agents.md', ['agents_md', 'project_rules']]
];

export function parseTask(task) {
  const raw = String(task || '').trim();
  const fileMentions = extractFileMentions(raw);
  const tokens = tokenize(raw);
  const expanded = unique([...expandChineseTerms(raw), ...expandEnglishTerms(raw)]);
  const allTerms = unique([...tokens, ...expanded, ...fileMentions.map((f) => path.basename(f).split('.')[0].toLowerCase())]);
  return {
    raw,
    fileMentions,
    tokens: allTerms,
    intent: classifyIntent(raw, allTerms),
    riskHints: classifyRiskHints(raw, allTerms)
  };
}

export function extractFileMentions(text) {
  const source = String(text || '');
  const quotedPattern = /(["'`])([^"'`\r\n]+?\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|mdx|yml|yaml|toml|css|scss|html|py|go|rs|java|kt|swift|sql|graphql|gql|proto|rb|php|sh|bash))\1/gi;
  const barePattern = /[\w@./\\-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|mdx|yml|yaml|toml|css|scss|html|py|go|rs|java|kt|swift|sql|graphql|gql|proto|rb|php|sh|bash)(?![a-z0-9_])/gi;
  const repositoryDotfilePattern = /(?:^|[\s"'`])((?:\.\/)?(?:[\w@.-]+[\\/])*\.(?:gitattributes|gitignore|editorconfig|dockerignore|npmrc|nvmrc))(?![\w.-])/gi;
  const matches = [];
  for (const match of source.matchAll(quotedPattern)) {
    matches.push({ index: match.index ?? 0, value: match[2].trim() });
  }
  const unquotedSource = source.replace(quotedPattern, (match) => ' '.repeat(match.length));
  for (const match of unquotedSource.matchAll(barePattern)) {
    matches.push({ index: match.index ?? 0, value: match[0] });
  }
  for (const match of unquotedSource.matchAll(repositoryDotfilePattern)) {
    const leadingLength = match[0].length - match[1].length;
    matches.push({ index: (match.index ?? 0) + leadingLength, value: match[1] });
  }
  matches.sort((left, right) => left.index - right.index);
  return unique(
    matches.map(({ value }) => value.replace(/\\/g, '/').replace(/^\.\//, ''))
  );
}

function tokenize(text) {
  const words = String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fa5]+/g)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !stopWords.has(x));
  return unique(words);
}

function expandChineseTerms(text) {
  const out = [];
  for (const [zh, terms] of zhTermMap) {
    if (text.includes(zh)) out.push(...terms);
  }
  return unique(out);
}

function expandEnglishTerms(text) {
  const normalized = String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  const out = [];
  for (const [term, terms] of enTermMap) {
    if (normalized.includes(term)) out.push(...terms);
  }
  return unique(out);
}

function classifyIntent(raw, terms) {
  const lower = raw.toLowerCase();
  if (/修复|fix|bug|error|报错|失败/.test(lower)) return 'bugfix';
  if (/重构|refactor/.test(lower)) return 'refactor';
  if (/迁移|migration|schema|数据库|存储|postgres|pgvector/.test(lower)) return 'migration';
  if (/测试|验证|test|spec|coverage|e2e/.test(lower)) return 'test';
  if (/文档|讲解|交接|知识库|docs|readme|handoff/.test(lower)) return 'docs';
  if (/ui|页面|组件|样式|css|frontend|前端|工作台|workbench/.test(lower)) return 'ui';
  if (terms.some((t) => ['api','route','schema','controller'].includes(t))) return 'api';
  return 'feature';
}

function classifyRiskHints(raw, terms) {
  const text = raw.toLowerCase();
  const hints = [];
  if (/auth|login|session|permission|rbac|权限|登录|认证|授权/.test(text) || terms.includes('auth')) hints.push('auth-change');
  if (/payment|billing|refund|ledger|settlement|支付|退款|账单|结算/.test(text) || terms.includes('payment')) hints.push('payment-change');
  if (/api|schema|openapi|graphql|proto|接口|合同/.test(text) || terms.includes('api')) hints.push('public-api-change');
  if (/database|migration|prisma|drizzle|sql|数据库|迁移/.test(text) || terms.includes('migration')) hints.push('database-migration');
  if (/build|ci|deploy|pipeline|构建|部署/.test(text)) hints.push('build-system-change');
  if (/shared|common|utils|types|公共|通用|类型/.test(text)) hints.push('shared-change');
  return unique(hints);
}
