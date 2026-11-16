import { describe, expect, it } from 'vitest';
import { imageChangeOptions } from './image-policy.js';

describe('imageChangeOptions', () => {
  it('keeps an Oracle server on its image when the plan names the image by system', () => {
    expect(imageChangeOptions('ubuntu-24.04', 'ocid1.image', 'sourceDetails.sourceId')).toEqual({
      ignoreChanges: ['sourceDetails.sourceId'],
    });
  });

  it('keeps an AWS server on its image when the plan names the image by system', () => {
    expect(imageChangeOptions('amazon-linux-2023', 'ami-', 'ami')).toEqual({
      ignoreChanges: ['ami'],
    });
  });

  it('follows an image id written in the plan, which is a deliberate change', () => {
    expect(
      imageChangeOptions(
        'ocid1.image.oc1.eu-frankfurt-1.example',
        'ocid1.image',
        'sourceDetails.sourceId',
      ),
    ).toEqual({});
    expect(imageChangeOptions(' ami-0123456789abcdef0 ', 'ami-', 'ami')).toEqual({});
  });
});
