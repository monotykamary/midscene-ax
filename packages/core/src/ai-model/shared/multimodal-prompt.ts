import type { ConversationUserMessage } from '@/ai-model/service-caller/types';
import {
  type TMultimodalPrompt,
  type TUserPrompt,
  userPromptToMultimodalPrompt,
  userPromptToString,
} from '@/common';
import { preProcessImageUrl } from '@midscene/shared/img';

export interface PreparedReferenceImage {
  name: string;
  url: string;
  role?: 'reference' | 'current';
}

/** Which kinds of images a prompt carries: supporting references, current-state evidence, or both. */
export const multimodalPromptImageRoles = (
  multimodalPrompt?: TMultimodalPrompt,
) => ({
  referenceImagesIncluded: !!multimodalPrompt?.images?.some(
    (image) => image.role !== 'current',
  ),
  currentEvidenceImagesIncluded: !!multimodalPrompt?.images?.some(
    (image) => image.role === 'current',
  ),
});

export interface PreparedUserPrompt {
  text: string;
  referenceImages: PreparedReferenceImage[];
}

const prepareReferenceImages = async (
  multimodalPrompt?: TMultimodalPrompt,
): Promise<PreparedReferenceImage[]> => {
  const referenceImages: PreparedReferenceImage[] = [];
  for (const image of multimodalPrompt?.images ?? []) {
    referenceImages.push({
      name: image.name,
      ...(image.role ? { role: image.role } : {}),
      url: await preProcessImageUrl(
        image.url,
        !!multimodalPrompt?.convertHttpImage2Base64,
      ),
    });
  }
  return referenceImages;
};

export const prepareUserPrompt = async (
  userPrompt: TUserPrompt,
): Promise<PreparedUserPrompt> => ({
  text: userPromptToString(userPrompt),
  referenceImages: await prepareReferenceImages(
    userPromptToMultimodalPrompt(userPrompt),
  ),
});

export const preparedReferenceImagesToMessages = (
  referenceImages: PreparedReferenceImage[],
): ConversationUserMessage[] => {
  if (referenceImages.length === 0) {
    return [];
  }

  const hasReference = referenceImages.some(
    (image) => image.role !== 'current',
  );
  return [
    ...(hasReference
      ? [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: 'Next, I will provide all the reference images. These reference images are supporting context only, not the current screenshot being evaluated, unless the task explicitly asks for comparison or matching.',
              },
            ],
          },
        ]
      : []),
    ...referenceImages.flatMap((image): ConversationUserMessage[] => [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              image.role === 'current'
                ? `This is fresh current-state evidence named '${image.name}', captured from the current observation. It may show a different region than other current-state images; evaluate all current-state evidence collectively:`
                : `this is the reference image named '${image.name}'. It is a reference image, not the current screenshot:`,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'image',
            url: image.url,
          },
        ],
      },
    ]),
  ];
};

export const multimodalPromptToMessages = async (
  multimodalPrompt?: TMultimodalPrompt,
): Promise<ConversationUserMessage[]> =>
  preparedReferenceImagesToMessages(
    await prepareReferenceImages(multimodalPrompt),
  );
