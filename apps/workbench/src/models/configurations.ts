export interface ModelConfiguration {
  model: string | null;
  effort?: string | null;
  tier?: string | null;
}
interface CatalogModel {
  id: string;
  defaultEffort?: string;
  efforts: string[];
  serviceTiers?: { id: string; name: string }[];
}
export function sameConfiguration(a: ModelConfiguration, b: ModelConfiguration) {
  return a.model === b.model && a.effort === b.effort && a.tier === b.tier;
}
export function recentModelChoices<T extends CatalogModel>(models: T[], history: ModelConfiguration[],
  active: ModelConfiguration, native: boolean) {
  const fallback = models.filter(m => m.id !== active.model)
    .map(m => ({model: m.id, effort: m.defaultEffort, tier: null}));
  const choices: {model: T; configuration: ModelConfiguration}[] = [];
  for (const configuration of [...history, active, ...fallback]) {
    const model = models.find(m => m.id === configuration.model);
    if (!model || (native && configuration.tier)) continue;
    if (configuration.effort && !model.efforts.includes(configuration.effort)) continue;
    if (configuration.tier && configuration.tier !== 'default' &&
        !model.serviceTiers?.some(tier => tier.id === configuration.tier)) continue;
    if (choices.some(choice => sameConfiguration(choice.configuration, configuration))) continue;
    choices.push({model, configuration});
    if (choices.length === 3) break;
  }
  return choices;
}
