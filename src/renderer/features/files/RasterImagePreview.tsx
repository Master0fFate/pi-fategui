import { ImageOff } from 'lucide-react';

interface RasterImagePreviewProps {
  data: string | undefined;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | undefined;
  path: string;
  detail?: string | undefined;
}

export function RasterImagePreview({ data, mimeType, path, detail }: RasterImagePreviewProps) {
  if (!data || !mimeType) {
    return <div className="preview-placeholder"><ImageOff size={22} /><strong>Image unavailable</strong><span>The bounded image preview is incomplete.</span></div>;
  }
  return (
    <figure className="raster-preview">
      <div className="raster-preview-canvas">
        <img src={`data:${mimeType};base64,${data}`} alt={`Preview of ${path}`} />
      </div>
      {detail && <figcaption>{detail}</figcaption>}
    </figure>
  );
}
