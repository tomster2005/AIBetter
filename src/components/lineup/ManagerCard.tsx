interface ManagerCardProps {
  name: string | null;
  imageUrl?: string | null;
  side: "home" | "away";
}

export function ManagerCard({ name, imageUrl, side }: ManagerCardProps) {
  return (
    <div className={`manager-card manager-card--${side}`}>
      <div className="manager-card__image-wrap">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="manager-card__image" />
        ) : (
          <div className="manager-card__placeholder" />
        )}
      </div>
      <div className="manager-card__info">
        <span className="manager-card__label">Manager</span>
        <span className="manager-card__name">{name ?? "–"}</span>
      </div>
    </div>
  );
}
