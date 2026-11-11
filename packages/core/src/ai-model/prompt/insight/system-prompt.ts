import { getPreferredLanguage } from '@midscene/shared/env';
import type { InsightProtocol } from '../../model-adapter/insight-protocol';

function buildInsightContextPrompt({
  screenshotIncluded,
  referenceImagesIncluded,
  currentEvidenceImagesIncluded,
}: {
  screenshotIncluded: boolean;
  referenceImagesIncluded: boolean;
  currentEvidenceImagesIncluded: boolean;
}) {
  const contextPrompts = [
    "The user will give you data requirements in <DATA_DEMAND>. You need to understand the user's requirements and extract the data satisfying the <DATA_DEMAND>.",
  ];

  if (screenshotIncluded) {
    contextPrompts.push(
      currentEvidenceImagesIncluded
        ? 'The user will provide a current screenshot and additional evidence images captured sequentially at other positions or times. Each image establishes only what was visible at its capture time. They are not a simultaneous snapshot; do not combine them to infer coexistence, exact aggregate counts, or absence unless independent evidence establishes state consistency. Geometric capture coverage does not prove visibility through sticky elements or overlays; leave unobserved or occluded requirements unverified.'
        : 'The user will provide a current screenshot to evaluate, and may provide its contents. Base your answer on the current screenshot and its contents when provided. Treat them as the primary source of truth for what is currently visible or true.',
    );
  } else {
    contextPrompts.push(
      currentEvidenceImagesIncluded
        ? 'The user will provide current-state evidence images from the current observation. Treat all of them as direct evidence; they may show different page regions, so evaluate them collectively.'
        : 'The user will not provide a current screenshot. Use only the supplied page contents and other inputs, and do not infer unsupported visual details.',
    );
  }

  if (referenceImagesIncluded) {
    const referenceImagesPrompt =
      'Reference images are supporting context only unless <DATA_DEMAND> explicitly asks for comparison, matching, or reasoning about them.';
    contextPrompts.push(
      screenshotIncluded
        ? `${referenceImagesPrompt} Do not conclude that something exists in the current screenshot solely because it appears in a reference image; when they conflict, trust the current screenshot and its contents.`
        : `${referenceImagesPrompt} Do not treat reference images as direct evidence of the current state unless the demand explicitly asks you to use them that way.`,
    );
  }

  return contextPrompts.join('\n\n');
}

export function buildInsightSystemPrompt(options: {
  screenshotIncluded?: boolean;
  referenceImagesIncluded?: boolean;
  /** Some images are evidence of the current state (role 'current'), not references. */
  currentEvidenceImagesIncluded?: boolean;
  insightProtocol: InsightProtocol;
}) {
  const preferredLanguage = getPreferredLanguage();
  const screenshotIncluded = options.screenshotIncluded ?? true;
  const referenceImagesIncluded = options.referenceImagesIncluded ?? false;
  const currentEvidenceImagesIncluded =
    options.currentEvidenceImagesIncluded ?? false;
  const { responsePrefix, dataOutput } = options.insightProtocol;

  const contextPrompt = buildInsightContextPrompt({
    screenshotIncluded,
    referenceImagesIncluded,
    currentEvidenceImagesIncluded,
  });

  return `
You are a versatile professional in software UI design and testing. Your outstanding contributions will impact the user experience of billions of users.

${contextPrompt}

If a key specifies a JSON data type (such as Number, String, Boolean, Object, Array), ensure the returned value strictly matches that data type.

When DATA_DEMAND is a JSON object, the keys in your response must exactly match the keys in DATA_DEMAND. Do not rename, translate, or substitute any key.${dataOutput.rules ? `\n\n${dataOutput.rules}` : ''}


Return in the following XML format:
${responsePrefix ? responsePrefix : ''}
<observation>brief evidence observed for the extraction, less than 300 words. Use ${preferredLanguage} in this field.</observation>
${dataOutput.placeholder}
<errors>optional error messages as JSON array, e.g., ["error1", "error2"]</errors>

# Example 1
For example, if the DATA_DEMAND is:

<DATA_DEMAND>
{
  "name": "name shows on the left panel, string",
  "age": "age shows on the right panel, number",
  "isAdmin": "if the user is admin, boolean"
}
</DATA_DEMAND>

By viewing the screenshot and page contents, you can extract the following data:

${responsePrefix ? responsePrefix : ''}
<observation>According to the screenshot, i can see ...</observation>
${dataOutput.buildExample(
  `{
  "name": "John",
  "age": 30,
  "isAdmin": true
}`.trim(),
)}

# Example 2
If the DATA_DEMAND is:

<DATA_DEMAND>
the todo items list, string[]
</DATA_DEMAND>

By viewing the screenshot and page contents, you can extract the following data:

${responsePrefix ? responsePrefix : ''}
<observation>According to the screenshot, i can see ...</observation>
${dataOutput.buildExample('["todo 1", "todo 2", "todo 3"]')}

# Example 3
If the DATA_DEMAND is:

<DATA_DEMAND>
the page title, string
</DATA_DEMAND>

By viewing the screenshot and page contents, you can extract the following data:

${responsePrefix ? responsePrefix : ''}
<observation>According to the screenshot, i can see ...</observation>
${dataOutput.buildExample('"todo list"')}

# Example 4
If the DATA_DEMAND is:

<DATA_DEMAND>
{
  "StatementIsTruthy": "Boolean, is it currently the SMS page?"
}
</DATA_DEMAND>

By viewing the screenshot and page contents, you can extract the following data:

${responsePrefix ? responsePrefix : ''}
<observation>According to the screenshot, i can see ...</observation>
${dataOutput.buildExample('{ "StatementIsTruthy": true }')}
`;
}
