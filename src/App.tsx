import { useState, useEffect } from "react";
import "./App.css";

function App() {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };

    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  const links = [
    {
      label: "Portfolio",
      text: "View Resume & Projects",
      href: "https://resume.nicholascerisano.com",
    },
    {
      label: "GitHub",
      text: "See My Software Projects",
      href: "https://github.com/EpicNicks",
    },
    {
      label: "LinkedIn",
      text: "Connect With Me",
      href: "https://www.linkedin.com/in/nicholas-cerisano/",
    },
  ];

  return (
    <>
      <div
        className={`cursor-circle ${isHovering ? "cursor-hover" : ""}`}
        style={{
          left: `${mousePosition.x}px`,
          top: `${mousePosition.y}px`,
        }}
      />
      <div className="container">
        <h1 className="name">Nicholas Cerisano</h1>
        <p className="title">Software Developer / Passionate Explorer</p>

        <nav className="links">
          {links.map((link, index) => (
            <div
              key={index}
              className="link-item"
              style={{ animationDelay: `${0.6 + index * 0.1}s` }}
            >
              <a
                href={link.href}
                className="link-button"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => setIsHovering(false)}
              >
                <span className="link-label">{link.label}</span>
                <span className="link-text">{link.text}</span>
              </a>
            </div>
          ))}
        </nav>
      </div>
    </>
  );
}

export default App;
