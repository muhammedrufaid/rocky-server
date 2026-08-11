/**
 * Migrate frontend areaGuides into MongoDB (`areaguidecontents`).
 *
 * Usage:
 *   node scripts/migrateAreaGuides.js
 *   node scripts/migrateAreaGuides.js --dry-run
 *
 * Idempotent: upserts by slug.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AreaGuide = require('../src/models/AreaGuide');

const AREA_GUIDES = [
  {
    order: 1,
    title: 'Dubai Marina',
    about:
      "Dubai Marina is Emaar’s flagship waterfront masterplan, built around a 3km man-made canal lined with high-rise towers and promenades. It also features standout buildings and clusters like Marina Promenade, Cayan Tower, Damac Towers, Marina Gate, and more. Residents also have direct pedestrian access to JBR Beach, Marina Walk, and Marina Mall.",
    keyHighlights: [
      { icon: 'buildings', title: 'Iconic high-rises' },
      { icon: 'waterfront', title: 'Waterfront lifestyle' },
      { icon: 'shopping', title: 'Marina Mall & retail' },
      { icon: 'transit', title: 'Metro & tram access' },
      { icon: 'yacht', title: 'Yacht clubs & water sports' },
      { icon: 'homes', title: 'Studios to penthouses' },
    ],
    agentOrders: [31, 32, 39],
    mapQuery: 'Dubai Marina, Dubai, UAE',
    image: '/assets/area-guides/opal-tower1.webp',
    path: '/area-guides/dubai-marina',
  },
  {
    order: 2,
    title: 'Jumeirah Village Circle',
    about:
      'Jumeirah Village Circle (JVC) is a large multi-developer masterplan, built in a circular layout, offering apartments to townhouses at accessible price points. This community features 15 districts with access to JVC’s Circle Mall area, schools, community parks, and neighborhood retail.',
    keyHighlights: [
      { icon: 'homes', title: 'Mix of townhouses, apartments, and villas' },
      {
        icon: 'buildings',
        title:
          'Central location bridging Downtown Dubai, Dubai Marina, and beyond',
      },
      {
        icon: 'transit',
        title: 'An affordable and well-connected community',
      },
      {
        icon: 'road',
        title:
          'Connectivity to Al Khail Road and Sheikh Mohammed Bin Zayed Road',
      },
      {
        icon: 'waterfront',
        title: 'Circular layout with several green spaces, parks, and more',
      },
      {
        icon: 'shopping',
        title:
          'Close proximity to schools, Circle Mall, community parks, and a growing neighborhood retail/dining scene',
      },
    ],
    agentOrders: [6, 7, 29, 37, 40],
    mapQuery: 'Jumeirah Village Circle, Dubai, UAE',
    image: '/assets/area-guides/lavitabella-jvc.webp',
    path: '/area-guides/jumeirah-village-circle',
  },
  {
    order: 3,
    title: 'Business Bay',
    about:
      "Business Bay, located just south of Downtown Dubai, is the city’s central hub for businesses and high-rise residential buildings, along the Dubai Water Canal, blending waterfront apartment living with commercial towers. Some of the standout developments include Vera Residences, Bay Square, The Opus, Peninsula, Executive Towers, and more, with close proximity to the world's tallest building, Burj Khalifa.",
    keyHighlights: [
      {
        icon: 'road',
        title: 'Direct access to Al Khail and Sheikh Zayed Road',
      },
      {
        icon: 'transit',
        title: 'Connectivity to the Dubai Metro via the Business Bay station',
      },
      {
        icon: 'shopping',
        title: 'Canal promenade with jogging paths, dining, and retail',
      },
      {
        icon: 'buildings',
        title: 'Dubai’s dynamic residential and business hub',
      },
      {
        icon: 'homes',
        title: 'Mix of high-rise apartments and commercial towers',
      },
      {
        icon: 'waterfront',
        title: 'Waterfront living along the Dubai Water Canal',
      },
    ],
    agentOrders: [7, 30, 31, 32, 35, 36],
    mapQuery: 'Business Bay, Dubai, UAE',
    image: '/assets/area-guides/bayy-businessbay.webp',
    path: '/area-guides/business-bay',
  },
  {
    order: 4,
    title: 'Madinat Jumeirah Living',
    about:
      'Madinat Jumeirah Living by Dubai Holding is a boutique masterplan located behind Burj Al Arab and Madinat Jumeirah, with low-rise apartment buildings. The community features several clusters, such as Asayel, Amaya, Lamtara, and Rahaal, with access to Jumeirah beaches, pools, courtyards, retail promenades, and more.',
    keyHighlights: [
      {
        icon: 'buildings',
        title: 'Located behind Burj Al Arab and Madinat Jumeirah',
      },
      {
        icon: 'road',
        title: 'Close proximity to Downtown Dubai and City Walk',
      },
      {
        icon: 'yacht',
        title: 'Boutique, resort-style residential community',
      },
      {
        icon: 'homes',
        title: 'Low-rise apartments with courtyards',
      },
      {
        icon: 'shopping',
        title: 'Upscale architectural design and premium finishes',
      },
      {
        icon: 'waterfront',
        title: 'Walking distance to Jumeirah beaches',
      },
    ],
    agentOrders: [38],
    mapQuery: 'Madinat Jumeirah Living, Dubai, UAE',
    image: '/assets/area-guides/mjl.webp',
    path: '/area-guides/marina-jumeirah-living',
  },
  {
    order: 5,
    title: 'Dubai South',
    about:
      'Dubai South is a master-planned city with seamless access to the world’s largest airport (upon completion), the Al Maktoum International Airport, designed to shape the future of business, living, and connectivity of Dubai.',
    keyHighlights: [
      {
        icon: 'buildings',
        title: 'A future-focused masterplan near Al Maktoum International Airport',
      },
      {
        icon: 'transit',
        title: 'A mix of residential, aviation-focused, and logistics zones',
      },
      {
        icon: 'road',
        title:
          'Close proximity to Sheikh Mohammed Bin Zayed Road and Emirates Road',
      },
      {
        icon: 'shopping',
        title: 'Central to Expo City Dubai',
      },
      {
        icon: 'waterfront',
        title: 'MBR City and Pulse-style green spaces and community parks',
      },
      {
        icon: 'homes',
        title: 'A mix of villas, apartments, and townhouses',
      },
    ],
    agentOrders: [7, 52],
    mapQuery: 'Dubai South, Dubai, UAE',
    image: '/assets/area-guides/dubai-south.webp',
    path: '/area-guides/dubai-south',
  },
  {
    order: 6,
    title: 'Jebel Ali Village',
    about:
      'Jebel Ali Village is a master-planned gated community featuring spacious homes, open layouts, top-tier amenities, and beautiful views of the valley, set in a location rich in history and poised for a bright future.',
    keyHighlights: [
      {
        icon: 'buildings',
        title: 'Close proximity to Jebel Ali Free Zone and business hubs',
      },
      {
        icon: 'homes',
        title: 'Mix of independent villas',
      },
      {
        icon: 'yacht',
        title: 'Family-friendly with a peaceful and suburban atmosphere',
      },
      {
        icon: 'road',
        title: 'Easy access to Expo Road and Sheikh Zayed Road',
      },
      {
        icon: 'shopping',
        title: 'Close to schools, community facilities, and nurseries',
      },
      {
        icon: 'waterfront',
        title: 'An established community with vast landscapes',
      },
    ],
    agentOrders: [29, 30, 31, 35, 45],
    mapQuery: 'Jebel Ali Village, Dubai, UAE',
    image: '/assets/area-guides/jav-banner.webp',
    path: '/area-guides/jebel-ali-village',
    listingsSearch: ['Jebel Ali', 'Wasl Gate'],
  },
  {
    order: 7,
    title: 'Dubai Media City',
    about:
      'Dubai Media City is a mixed-use free zone that has grown into a regional hub for media and creative industries, combining office spaces with a limited number of apartments and villas. The community is shaped by commercial towers, the Dubai Media City Amphitheatre, retail outlets, restaurants, and landscaped walkways. It sits close to Dubai Marina, Dubai Internet City, and Palm Jumeirah, with direct access to Sheikh Zayed Road and connections via the Dubai Metro and Dubai Tram.',
    keyHighlights: [
      { icon: 'buildings', title: 'Media Free Zone' },
      { icon: 'transit', title: 'Metro & Tram Access' },
      { icon: 'buildings', title: 'Commercial Towers' },
      { icon: 'shopping', title: 'Retail & Dining' },
      { icon: 'buildings', title: 'Business Hub' },
      { icon: 'landmark', title: 'Amphitheatre Events' },
    ],
    agentOrders: [6],
    mapQuery: 'Dubai Media City, Dubai, UAE',
    image: '/assets/area-guides/internet-city.webp',
    path: '/area-guides/dubai-media-city',
    listingsSearch: ['Dubai Media City', 'Jewel Tower'],
  },
  {
    order: 8,
    title: 'The Springs',
    about:
      "The Springs is a gated community of villas and townhouses developed by Emaar as part of the wider Emirates Living cluster. Homes range from 2 to 4 bedrooms, arranged around a series of interconnected lakes, landscaped parks and walking and cycling trails. The community has a family-oriented layout, with The Springs Souk serving as its retail and dining hub. It sits close to Dubai Marina, JLT, Internet City and Sheikh Zayed Road, giving residents a suburban setting within easy reach of the city's main business and leisure areas.",
    keyHighlights: [
      { icon: 'buildings', title: 'Gated Villa Community' },
      { icon: 'park', title: 'Lakes & Green Parks' },
      { icon: 'homes', title: '2–4 Bedroom Homes' },
      { icon: 'road', title: 'Walking & Cycling Trails' },
      { icon: 'shopping', title: 'The Springs Souk' },
      { icon: 'landmark', title: 'Family-Friendly Living' },
    ],
    agentOrders: [36],
    mapQuery: 'The Springs, Dubai, UAE',
    image: '/assets/area-guides/thesprings.webp',
    path: '/area-guides/the-springs',
  },
  {
    order: 9,
    title: 'The Greens',
    about:
      'The Greens is a low-rise apartment community developed by Emaar as part of the Emirates Living portfolio, offering one to four-bedroom apartments set among landscaped gardens and green open spaces. The community borders The Views, with lakes and walking paths running throughout. Its central location provides quick access to Sheikh Zayed Road, Dubai Marina, Dubai Internet City and Dubai Media City. Retail and dining options are available within the community, supporting a family-friendly, peaceful residential atmosphere for residents.',
    keyHighlights: [
      { icon: 'homes', title: 'Low-Rise Apartments' },
      { icon: 'park', title: 'Green Open Spaces' },
      { icon: 'waterfront', title: 'Lakes & Walking Paths' },
      { icon: 'landmark', title: 'Emirates Living Community' },
      { icon: 'shopping', title: 'Retail & Dining' },
      { icon: 'road', title: 'Easy Road Access' },
    ],
    agentOrders: [],
    mapQuery: 'The Greens, Dubai, UAE',
    image: '/assets/area-guides/thegreens.webp',
    path: '/area-guides/the-greens',
  },
  {
    order: 10,
    title: 'Emaar Beachfront',
    about:
      'The Greens is a low-rise apartment community developed by Emaar as part of the Emirates Living portfolio, offering one to four-bedroom apartments set among landscaped gardens and green open spaces. The community borders The Views, with lakes and walking paths running throughout. Its central location provides quick access to Sheikh Zayed Road, Dubai Marina, Dubai Internet City and Dubai Media City. Retail and dining options are available within the community, supporting a family-friendly, peaceful residential atmosphere for residents.',
    keyHighlights: [
      { icon: 'homes', title: 'Private Beach Access' },
      { icon: 'park', title: 'Green Open Spaces' },
      { icon: 'waterfront', title: 'Lakes & Walking Paths' },
      { icon: 'landmark', title: 'Emirates Living Community' },
      { icon: 'shopping', title: 'Retail & Dining' },
      { icon: 'road', title: 'Easy Road Access' },
    ],
    agentOrders: [],
    mapQuery: 'Emaar Beachfront, Dubai, UAE',
    image: '/assets/area-guides/emaar-beachfront.webp',
    path: '/area-guides/emaar-beachfront',
  },
  {
    order: 11,
    title: 'Dubai Creek Harbour',
    about:
      'Dubai Creek Harbour is a waterfront community developed by Emaar, offering apartments, townhouses and penthouses set along Dubai Creek Marina and Creek Beach. The community features a waterfront promenade, parks and open green spaces, along with retail and dining options within walking distance. Residents overlook Dubai Creek and the wider skyline, with the Ras Al Khor Wildlife Sanctuary located nearby. Dubai Creek Harbour has easy access to Ras Al Khor Road (E44), placing it close to Downtown Dubai and Dubai International Airport within a walkable, modern waterfront setting.',
    keyHighlights: [
      { icon: 'homes', title: 'Waterfront Community' },
      { icon: 'park', title: 'Creek Beach Living' },
      { icon: 'waterfront', title: 'Marina & Promenade' },
      { icon: 'landmark', title: 'Skyline Views' },
      { icon: 'shopping', title: 'Parks & Open Spaces' },
      { icon: 'road', title: 'Retail & Dining' },
    ],
    agentOrders: [32],
    mapQuery: 'Dubai Creek Harbour, Dubai, UAE',
    image: '/assets/area-guides/dubai-creek-harbour.webp',
    path: '/area-guides/dubai-creek-harbour',
  },
  {
    order: 12,
    title: 'Arabian Ranches',
    about:
      'Arabian Ranches is a gated villa and townhouse community developed by Emaar, set along landscaped streets with green open spaces and private gardens. The community is built around the Arabian Ranches Golf Club, with the Dubai Polo & Equestrian Club nearby, along with parks and walking trails throughout. A Community Centre provides retail and dining options, and several schools and nurseries are located within the area. Arabian Ranches has easy access to Sheikh Mohammed Bin Zayed Road (E311), supporting a family-oriented, peaceful suburban lifestyle for residents.',
    keyHighlights: [
      { icon: 'homes', title: 'Gated Villa Community' },
      { icon: 'park', title: 'Golf Course Living' },
      { icon: 'landmark', title: 'Polo & Equestrian' },
      { icon: 'road', title: 'Parks & Walking Trails' },
      { icon: 'shopping', title: 'Community Retail Centre' },
      { icon: 'buildings', title: 'Schools & Nurseries' },
    ],
    agentOrders: [],
    mapQuery: 'Arabian Ranches, Dubai, UAE',
    image: '/assets/area-guides/arabian-ranches.webp',
    path: '/area-guides/arabian-ranches',
  },
  {
    order: 13,
    title: 'Jumeirah Golf Estates',
    about:
      'Jumeirah Golf Estates is a gated golf community comprising villas, townhouses and apartments set around the Earth and Fire championship golf courses. Landscaped surroundings, parks and walking trails run throughout, supporting a family-friendly environment. The Jumeirah Golf Estates Clubhouse offers retail, dining and fitness facilities for residents. The community has easy access to Sheikh Mohammed Bin Zayed Road (E311) and its own metro station, connecting it to Dubai Marina, Expo City Dubai and Al Maktoum International Airport within a peaceful, green setting.',
    keyHighlights: [
      { icon: 'park', title: 'Championship Golf Courses' },
      { icon: 'homes', title: 'Gated Golf Community' },
      { icon: 'buildings', title: 'Villas & Townhouses' },
      { icon: 'shopping', title: 'Clubhouse Facilities' },
      { icon: 'transit', title: 'Metro Connectivity' },
      { icon: 'road', title: 'Green Open Spaces' },
    ],
    agentOrders: [],
    mapQuery: 'Jumeirah Golf Estates, Dubai, UAE',
    image: '/assets/area-guides/jumeirah-golf-estates.webp',
    path: '/area-guides/jumeirah-golf-estates',
  },
];

const slugFromPath = (path) => {
  const cleaned = String(path || '')
    .trim()
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
};

const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. dryRun=${dryRun}`);

  let created = 0;
  let updated = 0;

  for (const guide of AREA_GUIDES) {
    const slug = slugFromPath(guide.path);
    const payload = {
      order: guide.order,
      slug,
      title: guide.title,
      about: guide.about,
      keyHighlights: guide.keyHighlights,
      agentOrders: guide.agentOrders || [],
      mapQuery: guide.mapQuery,
      image: guide.image,
      path: guide.path,
      listingsSearch: guide.listingsSearch,
      isActive: true,
    };

    if (dryRun) {
      const existing = await AreaGuide.findOne({ slug }).select('_id slug order title');
      console.log(
        existing
          ? `[dry-run] would update ${slug} (${existing._id})`
          : `[dry-run] would create ${slug}`
      );
      continue;
    }

    const existing = await AreaGuide.findOne({ slug });
    if (existing) {
      await AreaGuide.findByIdAndUpdate(existing._id, payload, {
        runValidators: true,
      });
      updated += 1;
      console.log(`Updated: ${slug}`);
    } else {
      await AreaGuide.create(payload);
      created += 1;
      console.log(`Created: ${slug}`);
    }
  }

  const total = await AreaGuide.countDocuments();
  console.log(`Done. created=${created} updated=${updated} total=${total}`);
};

run()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
